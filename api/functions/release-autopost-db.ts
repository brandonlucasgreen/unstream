// Release autopost: database reads and writes (docs/specs/release-autopost-spec.md, "Tables").
//
// Both tables are server-only (RLS on, no policies), so everything here runs on the service-role
// client, and every caller has already checked the gate (canUseReleaseAutopost) and, for an
// artist's own request, the verified claim.
//
// **Reads throw rather than return empty.** An empty catalogue or an empty history would plan
// real posts from nothing: history empty means spacing starts over and a release gets repeated.
// A failed read must stop the run for that artist, not look like a fresh start.

import { getClient } from './db';
import type { AutopostKind, PastPost } from './autopost-plan';
import type { ReleaseSourceSummary } from '../shared/release-display';

/** Platforms whose listing comes from the artist's own links (spec, "Which releases qualify"). */
export const QUALIFYING_PLATFORMS = ['bandcamp', 'mirlo', 'faircamp', 'jamcoop'] as const;

function client() {
  const c = getClient();
  if (!c) throw new Error('Database not configured');
  return c;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export interface AutopostSettings {
  artistId: string;
  userId: string;
  enabled: boolean;
  enabledAt: string | null;
  postsPerWeek: number | null;
  timezone: string;
  /** HH:MM, or null for "Recommended": the channel's Buffer queue picks the time. */
  postTime: string | null;
  organizationId: string | null;
  channelIds: string[];
  kindsOff: AutopostKind[];
  templates: Partial<Record<AutopostKind, string[]>> | null;
  pausedReason: string | null;
}

interface SettingsRow {
  artist_id: string;
  user_id: string;
  enabled: boolean;
  enabled_at: string | null;
  posts_per_week: number | null;
  timezone: string;
  post_time: string | null;
  organization_id: string | null;
  channel_ids: string[] | null;
  kinds_off: string[] | null;
  templates: Partial<Record<AutopostKind, string[]>> | null;
  paused_reason: string | null;
}

const SETTINGS_COLUMNS = 'artist_id, user_id, enabled, enabled_at, posts_per_week, timezone, post_time, organization_id, channel_ids, kinds_off, templates, paused_reason';

function toSettings(row: SettingsRow): AutopostSettings {
  return {
    artistId: row.artist_id,
    userId: row.user_id,
    enabled: row.enabled,
    enabledAt: row.enabled_at,
    postsPerWeek: row.posts_per_week,
    timezone: row.timezone,
    postTime: row.post_time,
    organizationId: row.organization_id,
    channelIds: row.channel_ids ?? [],
    kindsOff: (row.kinds_off ?? []) as AutopostKind[],
    templates: row.templates,
    pausedReason: row.paused_reason,
  };
}

/** Every artist with autopost switched on and not paused. */
export async function getActiveAutopostSettings(): Promise<AutopostSettings[]> {
  const { data, error } = await client()
    .from('release_autopost_settings')
    .select(SETTINGS_COLUMNS)
    .eq('enabled', true)
    .is('paused_reason', null);
  if (error) throw new Error(`release_autopost_settings read failed: ${error.message}`);
  return (data as SettingsRow[]).map(toSettings);
}

/** One artist's settings, or null before they've saved any. */
export async function getAutopostSettings(artistId: string): Promise<AutopostSettings | null> {
  const { data, error } = await client()
    .from('release_autopost_settings')
    .select(SETTINGS_COLUMNS)
    .eq('artist_id', artistId)
    .maybeSingle();
  if (error) throw new Error(`release_autopost_settings read failed: ${error.message}`);
  return data ? toSettings(data as SettingsRow) : null;
}

/** Save an artist's settings whole. The caller has validated every field and checked ownership. */
export async function saveAutopostSettings(settings: AutopostSettings): Promise<void> {
  const { error } = await client()
    .from('release_autopost_settings')
    .upsert({
      artist_id: settings.artistId,
      user_id: settings.userId,
      enabled: settings.enabled,
      enabled_at: settings.enabledAt,
      posts_per_week: settings.postsPerWeek,
      timezone: settings.timezone,
      post_time: settings.postTime,
      organization_id: settings.organizationId,
      channel_ids: settings.channelIds,
      kinds_off: settings.kindsOff,
      templates: settings.templates,
      paused_reason: settings.pausedReason,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'artist_id' });
  if (error) throw new Error(`saving autopost settings failed: ${error.message}`);
}

/** Stops posting for an artist until they fix what's wrong (e.g. reconnect Buffer). */
export async function pauseAutopost(artistId: string, reason: string): Promise<void> {
  const { error } = await client()
    .from('release_autopost_settings')
    .update({ paused_reason: reason, updated_at: new Date().toISOString() })
    .eq('artist_id', artistId);
  if (error) throw new Error(`pausing autopost failed: ${error.message}`);
}

// ---------------------------------------------------------------------------------------------
// The artist and their owner
// ---------------------------------------------------------------------------------------------

export interface AutopostArtist {
  id: string;
  slug: string;
  name: string;
  /** Their own photo if they set one, else the one Unstream holds (from Bandcamp). */
  photoUrl: string | null;
  /** The verified owner's user id, or null when the claim isn't verified (any more). */
  verifiedOwnerId: string | null;
}

/** By id (the sweep) or by slug (the Promote page). */
export async function getAutopostArtist(artistId: string): Promise<AutopostArtist | null>;
export async function getAutopostArtist(by: { slug: string }): Promise<AutopostArtist | null>;
export async function getAutopostArtist(by: string | { slug: string }): Promise<AutopostArtist | null> {
  const query = client()
    .from('artists')
    .select('id, slug, name, image_url, artist_profiles ( user_id, verified_at, custom_image_url )');
  const { data, error } = await (typeof by === 'string' ? query.eq('id', by) : query.eq('slug', by.slug)).maybeSingle();
  if (error) throw new Error(`artist read failed: ${error.message}`);
  if (!data) return null;

  const row = data as {
    id: string; slug: string; name: string; image_url: string | null;
    artist_profiles: { user_id: string; verified_at: string | null; custom_image_url: string | null }[]
      | { user_id: string; verified_at: string | null; custom_image_url: string | null } | null;
  };
  const profile = Array.isArray(row.artist_profiles) ? row.artist_profiles[0] : row.artist_profiles;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    photoUrl: profile?.custom_image_url || row.image_url || null,
    verifiedOwnerId: profile?.verified_at ? profile.user_id : null,
  };
}

/** The account's email, for the feature gate. Null when the user no longer exists. */
export async function getUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await client().auth.admin.getUserById(userId);
  if (error) {
    if (error.status === 404) return null;
    throw new Error(`user read failed: ${error.message}`);
  }
  return data.user?.email ?? null;
}

// ---------------------------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------------------------

export interface AutopostRelease {
  id: string;
  slug: string;
  title: string;
  releaseType: string | null;
  releaseDate: string | null;
  datePrecision: string;
  status: 'announced' | 'released';
  createdAt: string;
  artworkUrl: string | null;
  note: string | null;
  sources: (ReleaseSourceSummary & { url: string })[];
}

/**
 * The releases autopost may post about: not hidden, not waiting in the dedup review queue, and
 * sold on a platform from the artist's own links. A Discogs-only release (a pressing someone
 * listed) never qualifies. Read fresh on every run, so a release hidden since it was planned
 * gives up its slot before it reaches Buffer.
 */
export async function getAutopostReleases(artistId: string): Promise<AutopostRelease[]> {
  const { data, error } = await client()
    .from('releases')
    .select('id, slug, title, release_type, release_date, date_precision, status, created_at, artwork_url, note,'
      + ' release_sources ( platform, url, release_offers ( price, currency, availability ) )')
    .eq('artist_id', artistId)
    .eq('is_hidden', false)
    .eq('needs_review', false)
    // One artist's catalogue: well under PostgREST's 1,000-row ceiling, which readAllPages exists for.
    .limit(500);
  if (error) throw new Error(`releases read failed: ${error.message}`);

  type Row = {
    id: string; slug: string; title: string; release_type: string | null; release_date: string | null;
    date_precision: string | null; status: string; created_at: string; artwork_url: string | null; note: string | null;
    release_sources: { platform: string; url: string; release_offers: ReleaseSourceSummary['offers'] | null }[] | null;
  };
  const qualifying = new Set<string>(QUALIFYING_PLATFORMS);
  return (data as unknown as Row[])
    .filter(r => (r.release_sources ?? []).some(s => qualifying.has(s.platform)))
    .map(r => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      releaseType: r.release_type,
      releaseDate: r.release_date,
      datePrecision: r.date_precision ?? 'unknown',
      status: r.status === 'announced' ? 'announced' : 'released',
      createdAt: r.created_at,
      artworkUrl: r.artwork_url,
      note: r.note,
      sources: (r.release_sources ?? []).map(s => ({ platform: s.platform, url: s.url, offers: s.release_offers ?? [] })),
    }));
}

// ---------------------------------------------------------------------------------------------
// Posts handed to Buffer
// ---------------------------------------------------------------------------------------------

/** How far back history is read: past the longest spacing any catalogue can have. */
const HISTORY_DAYS = 400;

/** Every slot claimed for this artist recently, as the planner's history. */
export async function getAutopostHistory(artistId: string, now: Date): Promise<PastPost[]> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
  const { data, error } = await client()
    .from('release_autopost_posts')
    .select('slot_at, kind, release_id, template_index, image_key, image_on_instagram, status')
    .eq('artist_id', artistId)
    .gte('slot_at', since)
    .order('slot_at', { ascending: true });
  if (error) throw new Error(`release_autopost_posts read failed: ${error.message}`);

  type Row = {
    slot_at: string; kind: AutopostKind; release_id: string | null; template_index: number;
    image_key: string | null; image_on_instagram: boolean; status: string;
  };
  // A failed slot never posted, so it isn't history: the planner fills it again and the push
  // retries it. Claimed and pushed slots are.
  return (data as Row[])
    .filter(r => r.status !== 'failed')
    .map(r => ({
      at: r.slot_at,
      kind: r.kind,
      releaseId: r.release_id,
      templateIndex: r.template_index,
      imageKey: r.image_key,
      imageOnInstagram: r.image_on_instagram,
    }));
}

export interface SlotClaim {
  artistId: string;
  slotAt: string;
  slotDate: string;
  kind: AutopostKind;
  releaseId: string | null;
  templateIndex: number;
  imageKey: string | null;
  imageOnInstagram: boolean;
}

/** Attempts before a failed slot is left alone. */
export const MAX_ATTEMPTS = 3;

/**
 * Claim a slot before calling Buffer, so two runs can never post it twice. Returns the row id,
 * or null when another run already has it (or it has failed MAX_ATTEMPTS times).
 *
 * A new slot is an insert that the unique (artist_id, slot_at) refuses a second time. A failed
 * slot is retaken with a conditional update on its status and attempt count, so of two runs
 * retrying it, one wins.
 */
export async function claimSlot(claim: SlotClaim): Promise<string | null> {
  const fields = {
    slot_date: claim.slotDate,
    kind: claim.kind,
    release_id: claim.releaseId,
    template_index: claim.templateIndex,
    image_key: claim.imageKey,
    image_on_instagram: claim.imageOnInstagram,
  };

  const inserted = await client()
    .from('release_autopost_posts')
    .upsert({ artist_id: claim.artistId, slot_at: claim.slotAt, status: 'pushing', attempts: 1, ...fields },
      { onConflict: 'artist_id,slot_at', ignoreDuplicates: true })
    .select('id');
  if (inserted.error) throw new Error(`claiming a slot failed: ${inserted.error.message}`);
  if (inserted.data && inserted.data.length > 0) return (inserted.data[0] as { id: string }).id;

  const { data: existing, error: readError } = await client()
    .from('release_autopost_posts')
    .select('id, status, attempts')
    .eq('artist_id', claim.artistId)
    .eq('slot_at', claim.slotAt)
    .maybeSingle();
  if (readError) throw new Error(`reading a claimed slot failed: ${readError.message}`);
  const row = existing as { id: string; status: string; attempts: number } | null;
  if (!row || row.status !== 'failed' || row.attempts >= MAX_ATTEMPTS) return null;

  const retaken = await client()
    .from('release_autopost_posts')
    .update({ status: 'pushing', attempts: row.attempts + 1, error: null, updated_at: new Date().toISOString(), ...fields })
    .eq('id', row.id)
    .eq('status', 'failed')
    .eq('attempts', row.attempts)
    .select('id');
  if (retaken.error) throw new Error(`retrying a slot failed: ${retaken.error.message}`);
  return retaken.data && retaken.data.length > 0 ? row.id : null;
}

export interface RecentPost {
  slotAt: string;
  kind: AutopostKind;
  releaseId: string | null;
  status: 'pushing' | 'pushed' | 'failed';
  error: string | null;
  channels: number;
}

/** The latest slots handed to Buffer, newest first, for the Promote page. */
export async function getRecentAutopostPosts(artistId: string, limit: number): Promise<RecentPost[]> {
  const { data, error } = await client()
    .from('release_autopost_posts')
    .select('slot_at, kind, release_id, status, error, buffer_post_ids')
    .eq('artist_id', artistId)
    .order('slot_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`release_autopost_posts read failed: ${error.message}`);
  type Row = { slot_at: string; kind: AutopostKind; release_id: string | null; status: RecentPost['status']; error: string | null; buffer_post_ids: unknown[] | null };
  return (data as Row[]).map(r => ({
    slotAt: r.slot_at,
    kind: r.kind,
    releaseId: r.release_id,
    status: r.status,
    error: r.error,
    channels: r.buffer_post_ids?.length ?? 0,
  }));
}

export interface SlotOutcome {
  /** 'pushed' once Buffer took it on at least one channel. */
  status: 'pushed' | 'failed';
  bufferPostIds: { channelId: string; postId: string }[];
  captions: Record<string, { service: string; text: string; imageUrl: string | null }>;
  error: string | null;
}

export async function finishSlot(id: string, outcome: SlotOutcome): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await client()
    .from('release_autopost_posts')
    .update({
      status: outcome.status,
      buffer_post_ids: outcome.bufferPostIds,
      captions: outcome.captions,
      error: outcome.error,
      pushed_at: outcome.status === 'pushed' ? now : null,
      updated_at: now,
    })
    .eq('id', id);
  if (error) throw new Error(`recording a slot failed: ${error.message}`);
}
