// API endpoint: /api/tips/settings — the artist's side of tips (docs/specs/artist-patronage-spec.md §8)
//
//   GET ?slug=   state, switch, fee, goals with progress, totals (this month and all time)
//   PUT          { slug, action, ... }
//     action 'update'      { tipsEnabled?: boolean, feeBasisPoints?: 0–500 }
//     action 'createGoal'  { title, targetCents }   (three open goals at most)
//     action 'closeGoal'   { goalId }
//
// Every call checks, server-side, that the caller owns a verified claim on the artist.
// Nothing here moves money: the artist's Stripe dashboard owns payouts, refunds and disputes.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getClient, resolveOwnedArtist } from './db';
import { authenticateBearer } from './middleware';
import { checkRateLimit, getClientIp } from './ratelimit';
import { isLiveMode, stripeMode, stripeRequest, type StripeAccount } from './stripe';
import { getGoals, getTipAccount, tipsState, type TipAccountRow } from './tips-db';
import { TIPS_CORS_HEADERS as CORS_HEADERS, respond } from './tips-http';
import {
  MAX_GOAL_TITLE_LENGTH,
  MAX_OPEN_GOALS,
  STRIPE_CONNECT_COUNTRIES,
  estimatedStripeFeeCents,
  isValidFeeBasisPoints,
} from '../shared/tips';
import { Sentry } from '../lib/sentry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
  queryStringParameters?: Record<string, string | undefined> | null;
}

export async function handler(event: HandlerEvent) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  const user = await authenticateBearer(event.headers.authorization);
  const rl = await checkRateLimit(user ? `user:${user.userId}` : `ip:${getClientIp(event.headers)}`, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response!;
  if (!user) return respond(401, { error: 'Not authenticated' });

  const client = getClient();
  if (!client) return respond(500, { error: 'Database not configured' });

  let body: Record<string, unknown> = {};
  if (event.httpMethod === 'PUT') {
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return respond(400, { error: 'Invalid JSON' });
    }
  } else if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const slug = (event.httpMethod === 'GET' ? event.queryStringParameters?.slug : body.slug) ?? '';
  const owned = await resolveOwnedArtist(String(slug), user.userId);
  if (!owned.ok) return respond(owned.status, { error: owned.error });
  const artistId = owned.artistId!;

  try {
    if (event.httpMethod === 'GET') return respond(200, await readSettings(client, artistId, user.userId));

    switch (body.action) {
      case 'update':
        return await updateSettings(client, artistId, user.userId, body);
      case 'createGoal':
        return await createGoal(client, artistId, body);
      case 'closeGoal':
        return await closeGoal(client, artistId, body);
      default:
        return respond(400, { error: 'Unknown action' });
    }
  } catch (err) {
    Sentry.captureException(err, { extra: { context: `tips-settings.${event.httpMethod}` } });
    return respond(500, { error: 'Something went wrong. Try again.' });
  }
}

/**
 * Pull the account's state from Stripe while it isn't live yet, so an artist coming back from
 * onboarding sees it without waiting on the webhook. Once charges are enabled, account.updated is
 * the only sync — no Stripe call per dashboard view.
 */
async function refreshFromStripe(client: SupabaseClient, account: TipAccountRow): Promise<TipAccountRow> {
  if (account.charges_enabled) return account;
  try {
    const remote = await stripeRequest<StripeAccount>('GET', `/v1/accounts/${encodeURIComponent(account.stripe_account_id)}`);
    const patch = {
      charges_enabled: !!remote.charges_enabled,
      details_submitted: !!remote.details_submitted,
      country: remote.country ?? account.country,
    };
    if (patch.charges_enabled !== account.charges_enabled || patch.details_submitted !== account.details_submitted) {
      await client.from('artist_tip_accounts').update(patch)
        .eq('artist_id', account.artist_id).eq('livemode', account.livemode);
    }
    return { ...account, ...patch };
  } catch (err) {
    // The dashboard still renders from what's stored; the webhook will catch up.
    Sentry.captureException(err, { extra: { context: 'tips-settings.refreshFromStripe' } });
    return account;
  }
}

function startOfMonthUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

interface TotalsRow { payment_count: number | string; gross_cents: number | string; amount_cents: number | string; application_fee_cents: number | string }

async function readTotals(client: SupabaseClient, artistId: string, since: string | null) {
  const { data, error } = await client.rpc('get_artist_tip_totals', {
    p_artist_id: artistId,
    p_livemode: isLiveMode(),
    p_since: since,
  });
  if (error) throw new Error(`get_artist_tip_totals failed: ${error.message}`);
  const row = ((data ?? []) as TotalsRow[])[0];
  const count = Number(row?.payment_count ?? 0);
  const grossCents = Number(row?.gross_cents ?? 0);
  const feeCents = Number(row?.application_fee_cents ?? 0);
  // Net is estimated at Stripe's standard rate per payment; the artist's Stripe dashboard has the
  // exact figure. Summing per-payment fees from totals needs the count for the fixed 30¢.
  const netCents = count === 0 ? 0 : grossCents - Math.round(grossCents * 0.029) - 30 * count - feeCents;
  return { count, grossCents, netCents, applicationFeeCents: feeCents };
}

async function readSettings(client: SupabaseClient, artistId: string, userId: string) {
  const stored = stripeMode() ? await getTipAccount(client, artistId) : null;
  // A previous owner's account is never shown or used as this owner's — not its state, not its totals.
  const account = stored && stored.user_id === userId ? await refreshFromStripe(client, stored) : null;
  const [goals, month, allTime] = await Promise.all([
    getGoals(client, artistId, { openOnly: false }),
    account ? readTotals(client, artistId, startOfMonthUtc()) : null,
    account ? readTotals(client, artistId, null) : null,
  ]);

  return {
    available: !!stripeMode(),
    livemode: isLiveMode(),
    state: tipsState(account),
    // So the dashboard can say "contact us" instead of offering a Connect button that will 409.
    foreignAccount: !!stored && !account,
    tipsEnabled: account?.tips_enabled ?? false,
    feeBasisPoints: account?.fee_basis_points ?? 0,
    country: account?.country ?? null,
    countries: STRIPE_CONNECT_COUNTRIES,
    goals,
    totals: account ? { month, allTime } : null,
    exampleStripeFeeCents: estimatedStripeFeeCents(500),
  };
}

async function updateSettings(client: SupabaseClient, artistId: string, userId: string, body: Record<string, unknown>) {
  const account = await getTipAccount(client, artistId);
  if (!account || account.user_id !== userId) return respond(409, { error: 'Connect Stripe first' });

  const patch: Record<string, unknown> = {};
  if (body.tipsEnabled !== undefined) {
    if (typeof body.tipsEnabled !== 'boolean') return respond(400, { error: 'tipsEnabled must be true or false' });
    if (body.tipsEnabled && !account.charges_enabled) {
      return respond(409, { error: 'Finish setting up Stripe before turning tips on' });
    }
    patch.tips_enabled = body.tipsEnabled;
  }
  if (body.feeBasisPoints !== undefined) {
    if (!isValidFeeBasisPoints(body.feeBasisPoints)) return respond(400, { error: 'The Unstream fee must be between 0% and 5%' });
    patch.fee_basis_points = body.feeBasisPoints;
  }
  if (Object.keys(patch).length === 0) return respond(400, { error: 'Nothing to update' });

  const { error } = await client.from('artist_tip_accounts').update(patch)
    .eq('artist_id', artistId).eq('livemode', account.livemode);
  if (error) throw new Error(`artist_tip_accounts update failed: ${error.message}`);
  return respond(200, await readSettings(client, artistId, userId));
}

async function createGoal(client: SupabaseClient, artistId: string, body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > MAX_GOAL_TITLE_LENGTH || /[<>]/.test(title)) {
    return respond(400, { error: `Give the goal a title of up to ${MAX_GOAL_TITLE_LENGTH} characters` });
  }
  const target = body.targetCents;
  if (typeof target !== 'number' || !Number.isInteger(target) || target < 100 || target > 10000000) {
    return respond(400, { error: 'Set a target between $1 and $100,000' });
  }

  const { count, error: countError } = await client.from('artist_goals')
    .select('id', { count: 'exact', head: true })
    .eq('artist_id', artistId).eq('status', 'open');
  if (countError) throw new Error(`artist_goals count failed: ${countError.message}`);
  if ((count ?? 0) >= MAX_OPEN_GOALS) return respond(409, { error: `Close a goal first — up to ${MAX_OPEN_GOALS} can be open` });

  const { error } = await client.from('artist_goals').insert({
    artist_id: artistId,
    title,
    target_cents: target,
  });
  if (error) throw new Error(`artist_goals insert failed: ${error.message}`);
  return respond(200, { goals: await getGoals(client, artistId, { openOnly: false }) });
}

async function closeGoal(client: SupabaseClient, artistId: string, body: Record<string, unknown>) {
  const goalId = typeof body.goalId === 'string' ? body.goalId : '';
  if (!UUID_REGEX.test(goalId)) return respond(400, { error: 'Invalid goal' });
  // Scoped to this artist, so an owner can only close their own goals. No refunds on close:
  // tips were unconditional (spec §3.4).
  const { error } = await client.from('artist_goals')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', goalId).eq('artist_id', artistId).eq('status', 'open');
  if (error) throw new Error(`artist_goals update failed: ${error.message}`);
  return respond(200, { goals: await getGoals(client, artistId, { openOnly: false }) });
}
