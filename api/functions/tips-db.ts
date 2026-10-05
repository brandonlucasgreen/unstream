// Artist tips: eligibility and reads (docs/specs/artist-patronage-spec.md §4, §6, §9).
//
// `tipEligibility` is the single definition of "this artist can take a tip right now". Checkout
// calls it on every request rather than trusting anything the page showed, and the Tip button on
// the artist page and result cards reads the same rules through `getTipsLiveSlugs`.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { isLiveMode, stripeMode, type StripeAccount } from './stripe';
import { Sentry } from '../lib/sentry';

export interface TipAccountRow {
  artist_id: string;
  livemode: boolean;
  stripe_account_id: string;
  user_id: string;
  charges_enabled: boolean;
  details_submitted: boolean;
  country: string | null;
  tips_approved_at: string | null;
  tips_enabled: boolean;
  fee_basis_points: number;
  addendum_accepted_at: string;
  addendum_version: string;
  /** Set when the artist disconnected Unstream in Stripe; the row is then treated as no account. */
  deauthorized_at: string | null;
  created_at: string;
}

export interface GoalRow {
  id: string;
  artist_id: string;
  title: string;
  target_cents: number;
  status: 'open' | 'closed';
  livemode: boolean;
  created_at: string;
  closed_at: string | null;
}

export interface Goal {
  id: string;
  title: string;
  targetCents: number;
  raisedCents: number;
  status: 'open' | 'closed';
}

/**
 * Tips are private while Brandon tests them (2026-10-03): only the admin account (ADMIN_EMAIL) can
 * see Manage Tips or connect Stripe. Fans can only reach a Tip button for an artist an admin has
 * approved, so this one check keeps the whole feature to the admin's own profiles even with a live
 * Stripe key. Opening tips to artists means deleting this gate and its callers' checks.
 */
export function canSetUpTips(email: string): boolean {
  const admin = process.env.ADMIN_EMAIL;
  return !!admin && email.toLowerCase() === admin.toLowerCase();
}

/**
 * Where an artist stands, from the artist's own point of view (spec §8). Before Stripe enables
 * charges there are three cases, and only 'onboarding' is one the artist can fix by going back to
 * Stripe: 'stripe_review' means Stripe has everything and is checking it, 'stripe_declined' means
 * Stripe turned the account down.
 */
export type TipsState =
  | 'not_connected'
  | 'onboarding'
  | 'stripe_review'
  | 'stripe_declined'
  | 'awaiting_approval'
  | 'connected';

/** Why an account isn't taking charges yet, read from Stripe's live account object. */
export type StripeHold = 'needs_details' | 'in_review' | 'declined';

export function stripeHold(account: StripeAccount): StripeHold {
  const requirements = account.requirements ?? {};
  if ((requirements.disabled_reason ?? '').startsWith('rejected')) return 'declined';
  const due = [...(requirements.currently_due ?? []), ...(requirements.past_due ?? [])];
  if (!account.details_submitted || due.length > 0) return 'needs_details';
  return 'in_review';
}

/**
 * `hold` comes from Stripe's live account and is only known while charges are off; without it (the
 * Stripe read failed, or nobody asked) an account that can't take charges reads as 'onboarding'.
 */
export function tipsState(account: TipAccountRow | null, hold: StripeHold | null = null): TipsState {
  // A disconnected account is as good as none: the artist connects again from scratch.
  if (!account || account.deauthorized_at) return 'not_connected';
  if (!account.charges_enabled) {
    if (hold === 'in_review') return 'stripe_review';
    if (hold === 'declined') return 'stripe_declined';
    return 'onboarding';
  }
  if (!account.tips_approved_at) return 'awaiting_approval';
  return 'connected';
}

/** Taking tips right now: connected, approved, switched on. Ownership is checked separately. */
export function isAccountLive(account: TipAccountRow | null): boolean {
  return !!account && !account.deauthorized_at && account.charges_enabled && !!account.tips_approved_at && account.tips_enabled;
}

export async function getTipAccount(client: SupabaseClient, artistId: string): Promise<TipAccountRow | null> {
  const { data, error } = await client
    .from('artist_tip_accounts')
    .select('*')
    .eq('artist_id', artistId)
    .eq('livemode', isLiveMode())
    .maybeSingle();
  if (error) throw new Error(`artist_tip_accounts read failed: ${error.message}`);
  return (data as TipAccountRow | null) ?? null;
}

export type Eligibility =
  | { ok: true; artist: { id: string; slug: string; name: string; imageUrl: string | null }; account: TipAccountRow }
  | { ok: false; status: number; reason: string; artist?: { id: string; slug: string; name: string; imageUrl: string | null } };

/**
 * Can this artist take a tip right now? Every condition is re-read, none trusted from a client:
 * Stripe configured, the artist claimed and verified, a connected account in this Stripe mode that
 * the *current* profile owner connected, charges enabled by Stripe, approved by an admin, and
 * switched on by the artist.
 */
export async function tipEligibility(slug: string): Promise<Eligibility> {
  const client = getClient();
  if (!client || !stripeMode()) return { ok: false, status: 503, reason: 'Tips are not available right now' };

  const { data: artistRow, error } = await client
    .from('artists')
    .select('id, slug, name, image_url, match_confidence')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(`artist read failed: ${error.message}`);
  if (!artistRow) return { ok: false, status: 404, reason: 'Artist not found' };

  const a = artistRow as { id: string; slug: string; name: string; image_url: string | null; match_confidence: string };
  const artist = { id: a.id, slug: a.slug, name: a.name, imageUrl: a.image_url };
  const notTaking = { ok: false as const, status: 409, reason: `${a.name} isn't taking tips yet`, artist };
  if (a.match_confidence !== 'claimed') return notTaking;

  const { data: profile, error: profileError } = await client
    .from('artist_profiles')
    .select('user_id, verified_at, custom_image_url')
    .eq('artist_id', a.id)
    .maybeSingle();
  if (profileError) throw new Error(`artist_profiles read failed: ${profileError.message}`);
  const p = profile as { user_id: string; verified_at: string | null; custom_image_url: string | null } | null;
  if (!p?.verified_at) return notTaking;
  if (p.custom_image_url) artist.imageUrl = p.custom_image_url;

  const account = await getTipAccount(client, a.id);
  if (!account || !isAccountLive(account) || account.user_id !== p.user_id) return notTaking;

  return { ok: true, artist, account };
}

/**
 * Which of these slugs can take a tip right now — for the Tip button on search results and the
 * artist page. The same conditions as `tipEligibility`, in two batched reads. Returns an empty set
 * when Stripe isn't configured (tips off) and null when the read fails, which callers treat as
 * "no Tip button" while it's reported.
 */
export async function getTipsLiveSlugs(slugs: string[]): Promise<Set<string> | null> {
  const unique = [...new Set(slugs.filter(Boolean))].slice(0, 50);
  const live = new Set<string>();
  if (unique.length === 0 || !stripeMode()) return live;

  try {
    const client = getClient();
    if (!client) return null;
    const { data, error } = await client
      .from('artist_tip_accounts')
      .select('user_id, charges_enabled, tips_enabled, tips_approved_at, artists!inner(slug, match_confidence, artist_profiles(user_id, verified_at))')
      .eq('livemode', isLiveMode())
      .eq('tips_enabled', true)
      .eq('charges_enabled', true)
      .is('deauthorized_at', null)
      .not('tips_approved_at', 'is', null)
      .in('artists.slug', unique);
    if (error) throw new Error(error.message);

    type Row = {
      user_id: string;
      artists: { slug: string; match_confidence: string; artist_profiles: Array<{ user_id: string; verified_at: string | null }> | { user_id: string; verified_at: string | null } | null };
    };
    for (const row of (data ?? []) as unknown as Row[]) {
      const artist = row.artists;
      if (!artist || artist.match_confidence !== 'claimed') continue;
      const profiles = Array.isArray(artist.artist_profiles) ? artist.artist_profiles : artist.artist_profiles ? [artist.artist_profiles] : [];
      if (profiles.some(p => p.user_id === row.user_id && p.verified_at)) live.add(artist.slug);
    }
    return live;
  } catch (err) {
    Sentry.captureMessage('[tips-db] tips-live lookup failed', {
      level: 'error',
      extra: { context: 'tips-db.getTipsLiveSlugs', error: String(err) },
    });
    return null;
  }
}

/**
 * An artist's goals in this Stripe mode, with what each has received (succeeded payments, less any
 * refunded share). Goals carry the mode they were made in, so one set up while testing locally
 * (`npm run dev` writes to production Supabase) never shows on the live page or takes live tips.
 */
export async function getGoals(client: SupabaseClient, artistId: string, opts: { openOnly: boolean }): Promise<Goal[]> {
  let query = client
    .from('artist_goals')
    .select('id, artist_id, title, target_cents, status, livemode, created_at, closed_at')
    .eq('artist_id', artistId)
    .eq('livemode', isLiveMode())
    .order('created_at', { ascending: false })
    .limit(opts.openOnly ? 3 : 20);
  if (opts.openOnly) query = query.eq('status', 'open');
  const { data, error } = await query;
  if (error) throw new Error(`artist_goals read failed: ${error.message}`);
  const rows = (data ?? []) as GoalRow[];
  if (rows.length === 0) return [];

  const { data: progress, error: progressError } = await client.rpc('get_goal_progress', {
    p_goal_ids: rows.map(r => r.id),
    p_livemode: isLiveMode(),
  });
  if (progressError) throw new Error(`get_goal_progress failed: ${progressError.message}`);
  const raised = new Map<string, number>();
  for (const r of (progress ?? []) as Array<{ goal_id: string; raised_cents: number | string }>) {
    raised.set(r.goal_id, Number(r.raised_cents));
  }

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    targetCents: r.target_cents,
    raisedCents: raised.get(r.id) ?? 0,
    status: r.status,
  }));
}

/**
 * Spec §3.3: a fan's first successful payment marks the artist supported in their saved artists, if
 * they have them saved. Called when a signed-in tip is recorded and when a fan saves a signed-out tip
 * to their account afterwards. Best effort: the payment is recorded either way.
 */
export async function markArtistSupported(client: SupabaseClient, userId: string, artistId: string): Promise<void> {
  const { error } = await client
    .from('saved_artists')
    .update({ supported: true, supported_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('artist_id', artistId)
    .eq('supported', false);
  if (error) Sentry.captureMessage('[tips-db] mark supported failed', { level: 'warning', extra: { error: error.message } });
}
