// API endpoint: GET/POST /api/admin/tips — approving each artist's tips setup
// (docs/specs/artist-patronage-spec.md §6, gate 3). Admin only.
//
// The defence against someone claiming an artist's profile and collecting their tips: before
// checkout will take a payment for an artist, an admin compares the claimed artist with the
// connected Stripe account's business name and country, and approves.
//
//   GET                                                    accounts in this Stripe mode, awaiting approval first
//   POST { action: 'approve', artistId, stripeAccountId }  approve exactly the account the admin looked at,
//                                                          then email the artist that tips are on
//   POST { action: 'revoke', artistId }                    switch tips off for abuse or misrepresentation

import { getClient } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { isLiveMode, stripeMode, stripeRequest, type StripeAccount } from './stripe';
import { tipsState, type TipAccountRow } from './tips-db';
import { sendTipsApprovedEmail } from './notifications';
import { purgeCacheTags } from './purge-cache';
import { Sentry, withSentry } from '../lib/sentry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string | null;
}

async function handleRequest(event: HandlerEvent) {
  const CORS_HEADERS = buildCorsHeaders(event.headers.origin || event.headers.Origin, false);
  const respond = (statusCode: number, body: unknown) => ({ statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  const admin = await authenticateAdmin(event.headers.authorization || event.headers.Authorization || undefined);
  if (!admin) return respond(401, { error: 'Unauthorized' });

  const client = getClient();
  if (!client) return respond(500, { error: 'Database not configured' });
  if (!stripeMode()) return respond(200, { available: false, accounts: [] });

  try {
    if (event.httpMethod === 'GET') {
      const { data, error } = await client
        .from('artist_tip_accounts')
        .select('*, artists(name, slug, artist_profiles(user_id, email, verified_at))')
        .eq('livemode', isLiveMode())
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);

      type Row = TipAccountRow & {
        artists: { name: string; slug: string; artist_profiles: { user_id: string; email: string; verified_at: string | null } | Array<{ user_id: string; email: string; verified_at: string | null }> | null } | null;
      };
      const rows = (data ?? []) as unknown as Row[];

      // The Stripe side of the comparison, read live so it's what Stripe holds now. A handful of
      // rows at most; approvals are a rare, human-paced action.
      const accounts = await Promise.all(rows.map(async row => {
        let stripe: { businessName: string | null; country: string | null; email: string | null; error?: string } = {
          businessName: null, country: row.country, email: null,
        };
        try {
          const remote = await stripeRequest<StripeAccount>('GET', `/v1/accounts/${encodeURIComponent(row.stripe_account_id)}`);
          stripe = {
            businessName: remote.business_profile?.name ?? remote.settings?.dashboard?.display_name ?? null,
            country: remote.country ?? null,
            email: remote.email ?? null,
          };
        } catch (err) {
          stripe.error = err instanceof Error ? err.message : 'Stripe lookup failed';
        }
        const profiles = row.artists?.artist_profiles;
        const profile = Array.isArray(profiles) ? profiles[0] : profiles;
        return {
          artistId: row.artist_id,
          artistName: row.artists?.name ?? null,
          artistSlug: row.artists?.slug ?? null,
          claimEmail: profile?.email ?? null,
          claimVerified: !!profile?.verified_at,
          // A mismatch here means the profile changed hands after connecting: never approve it.
          connectedByCurrentOwner: !!profile && profile.user_id === row.user_id,
          stripeAccountId: row.stripe_account_id,
          stripe,
          state: tipsState(row),
          chargesEnabled: row.charges_enabled,
          // Disconnected from Stripe's side; the artist has to connect a new account.
          deauthorizedAt: row.deauthorized_at ?? null,
          tipsEnabled: row.tips_enabled,
          approvedAt: row.tips_approved_at,
          feeBasisPoints: row.fee_basis_points,
          createdAt: row.created_at,
        };
      }));
      accounts.sort((a, b) => Number(!!a.approvedAt) - Number(!!b.approvedAt));
      return respond(200, { available: true, livemode: isLiveMode(), accounts });
    }

    if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return respond(400, { error: 'Invalid JSON' });
    }
    const artistId = typeof body.artistId === 'string' ? body.artistId : '';
    if (!UUID_REGEX.test(artistId)) return respond(400, { error: 'Invalid artist' });

    if (body.action === 'approve') {
      const stripeAccountId = typeof body.stripeAccountId === 'string' ? body.stripeAccountId : '';
      return respond(...await approve(client, artistId, stripeAccountId));
    }

    if (body.action === 'revoke') {
      const { error } = await client.from('artist_tip_accounts')
        .update({ tips_approved_at: null, tips_enabled: false })
        .eq('artist_id', artistId)
        .eq('livemode', isLiveMode());
      if (error) throw new Error(error.message);
      return respond(200, { ok: true });
    }

    return respond(400, { error: 'Unknown action' });
  } catch (err) {
    Sentry.captureException(err, { extra: { context: `admin-tips.${event.httpMethod}` } });
    return respond(500, { error: 'Something went wrong' });
  }
}

type Client = NonNullable<ReturnType<typeof getClient>>;

/**
 * Approve one artist's tips setup. Everything the admin's decision rests on is re-read here, not
 * trusted from the list they were shown: the account must be the one they looked at, Stripe must
 * have enabled charges, the account must not have been disconnected since, and whoever connected
 * it must still be the profile's verified owner. Then the artist is told, best effort.
 */
async function approve(client: Client, artistId: string, stripeAccountId: string): Promise<[number, unknown]> {
  // Matching on the account id means an approval can't land on a different account than the
  // one the admin was shown — if it changed in between, this finds nothing.
  const { data: row, error } = await client.from('artist_tip_accounts')
    .select('*')
    .eq('artist_id', artistId)
    .eq('livemode', isLiveMode())
    .eq('stripe_account_id', stripeAccountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const account = row as TipAccountRow | null;
  if (!account) return [409, { error: 'That account changed. Reload and check again.' }];
  if (account.deauthorized_at) return [409, { error: 'The artist disconnected this Stripe account. They need to connect again.' }];
  if (!account.charges_enabled) return [409, { error: "Stripe hasn't enabled charges on this account yet. Approve once it has." }];
  if (account.tips_approved_at) return [200, { ok: true }];

  const { data: profile, error: profileError } = await client.from('artist_profiles')
    .select('user_id, verified_at')
    .eq('artist_id', artistId)
    .maybeSingle();
  if (profileError) throw new Error(profileError.message);
  const p = profile as { user_id: string; verified_at: string | null } | null;
  if (!p?.verified_at || p.user_id !== account.user_id) {
    return [409, { error: "This account wasn't connected by the profile's current verified owner. Don't approve it." }];
  }

  const approvedAt = new Date().toISOString();
  // Guarded on still being unapproved, so a double click approves (and emails) once.
  const { data: updated, error: updateError } = await client.from('artist_tip_accounts')
    .update({ tips_approved_at: approvedAt })
    .eq('artist_id', artistId)
    .eq('livemode', isLiveMode())
    .eq('stripe_account_id', stripeAccountId)
    .is('tips_approved_at', null)
    .select('artist_id');
  if (updateError) throw new Error(updateError.message);
  if (!updated || updated.length === 0) return [200, { ok: true }];

  const { data: artist, error: artistError } = await client.from('artists')
    .select('name, slug')
    .eq('id', artistId)
    .maybeSingle();
  if (artistError || !artist) {
    Sentry.captureMessage('[admin-tips] approved, but the artist row could not be read for the email', {
      level: 'warning', extra: { artistId },
    });
    return [200, { ok: true }];
  }
  const { name, slug } = artist as { name: string; slug: string };
  await purgeCacheTags([`artist-${slug}`], 'AdminTips');
  await sendTipsApprovedEmail({
    client, userId: account.user_id, artistName: name, slug, referenceId: `${stripeAccountId}:${approvedAt}`,
  });
  return [200, { ok: true }];
}

export const handler = withSentry(handleRequest);
