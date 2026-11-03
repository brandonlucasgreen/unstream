// Release campaigns: database reads and writes (docs/specs/release-autopost-spec.md, "Release
// campaigns"). Server-only tables; every caller has checked the gate and the verified claim.
//
// Unlike autopost's slots, which are planned fresh each time, a campaign's posts are the artist's
// own words and dates, so they're stored ahead: 'planned' until the autopost sweep hands them to
// Buffer 72 hours before they go out. As with autopost, **reads throw rather than return empty**:
// a missing campaign would let autopost post on its days.

import { getClient } from './db';
import type { PastPost, PlanCampaign } from './autopost-plan';
import { MAX_ATTEMPTS } from './release-autopost-db';

function client() {
  const c = getClient();
  if (!c) throw new Error('Database not configured');
  return c;
}

export type CampaignPostStatus = 'planned' | 'pushing' | 'pushed' | 'failed';

export interface CampaignPost {
  id: string;
  campaignId: string;
  artistId: string;
  step: string;
  postDate: string;
  text: string;
  imageKey: string | null;
  status: CampaignPostStatus;
  attempts: number;
  slotAt: string | null;
  bufferPostIds: { channelId: string; postId: string }[];
  captions: Record<string, { service: string; text: string; imageUrl: string | null }>;
  error: string | null;
}

export interface Campaign {
  id: string;
  artistId: string;
  userId: string;
  releaseId: string;
  releaseDate: string;
  createdAt: string;
  posts: CampaignPost[];
}

const POST_COLUMNS = 'id, campaign_id, artist_id, step, post_date, text, image_key, status, attempts, slot_at, buffer_post_ids, captions, error';

interface PostRow {
  id: string; campaign_id: string; artist_id: string; step: string; post_date: string; text: string;
  image_key: string | null; status: CampaignPostStatus; attempts: number; slot_at: string | null;
  buffer_post_ids: CampaignPost['bufferPostIds'] | null; captions: CampaignPost['captions'] | null; error: string | null;
}

const toPost = (r: PostRow): CampaignPost => ({
  id: r.id,
  campaignId: r.campaign_id,
  artistId: r.artist_id,
  step: r.step,
  postDate: r.post_date,
  text: r.text,
  imageKey: r.image_key,
  status: r.status,
  attempts: r.attempts,
  slotAt: r.slot_at,
  bufferPostIds: r.buffer_post_ids ?? [],
  captions: r.captions ?? {},
  error: r.error,
});

interface CampaignRow {
  id: string; artist_id: string; user_id: string; release_id: string; release_date: string; created_at: string;
  release_campaign_posts: PostRow[] | null;
}

const toCampaign = (r: CampaignRow): Campaign => ({
  id: r.id,
  artistId: r.artist_id,
  userId: r.user_id,
  releaseId: r.release_id,
  releaseDate: r.release_date,
  createdAt: r.created_at,
  posts: (r.release_campaign_posts ?? []).map(toPost).sort((a, b) => (a.postDate < b.postDate ? -1 : 1)),
});

/** An artist's running (not cancelled) campaigns, with their posts. */
export async function listCampaigns(artistId: string): Promise<Campaign[]> {
  const { data, error } = await client()
    .from('release_campaigns')
    .select(`id, artist_id, user_id, release_id, release_date, created_at, release_campaign_posts ( ${POST_COLUMNS} )`)
    .eq('artist_id', artistId)
    .eq('status', 'active')
    .order('release_date', { ascending: true })
    .limit(50);
  if (error) throw new Error(`release_campaigns read failed: ${error.message}`);
  return (data as unknown as CampaignRow[]).map(toCampaign);
}

export interface NewPost {
  step: string;
  postDate: string;
  text: string;
  imageKey: string | null;
}

async function savePosts(campaignId: string, releaseDate: string, posts: NewPost[]): Promise<void> {
  const { error } = await client().rpc('save_release_campaign', {
    p_campaign_id: campaignId,
    p_release_date: releaseDate,
    p_posts: posts.map(p => ({ step: p.step, post_date: p.postDate, text: p.text, image_key: p.imageKey })),
  });
  if (error) throw new Error(`saving campaign posts failed: ${error.message}`);
}

/** Start a campaign. Returns null when the release already has one running. */
export async function createCampaign(input: { artistId: string; userId: string; releaseId: string; releaseDate: string; posts: NewPost[] }): Promise<string | null> {
  const { data, error } = await client()
    .from('release_campaigns')
    .insert({ artist_id: input.artistId, user_id: input.userId, release_id: input.releaseId, release_date: input.releaseDate })
    .select('id')
    .single();
  if (error) {
    // The one-running-campaign-per-release index.
    if (error.code === '23505') return null;
    throw new Error(`creating a campaign failed: ${error.message}`);
  }
  const id = (data as { id: string }).id;
  try {
    await savePosts(id, input.releaseDate, input.posts);
  } catch (err) {
    // Don't leave an empty campaign behind holding the release.
    await client().from('release_campaigns').delete().eq('id', id);
    throw err;
  }
  return id;
}

/** Replace a campaign's unsent posts and its release date. Sent posts are never touched. */
export async function updateCampaign(campaignId: string, releaseDate: string, posts: NewPost[]): Promise<void> {
  await savePosts(campaignId, releaseDate, posts);
}

/** Stop a campaign: its unsent posts are deleted, and those already in Buffer stay there. */
export async function cancelCampaign(campaignId: string): Promise<void> {
  const now = new Date().toISOString();
  const posts = await client().from('release_campaign_posts').delete()
    .eq('campaign_id', campaignId).in('status', ['planned', 'failed']);
  if (posts.error) throw new Error(`deleting campaign posts failed: ${posts.error.message}`);
  const { error } = await client().from('release_campaigns')
    .update({ status: 'cancelled', updated_at: now }).eq('id', campaignId);
  if (error) throw new Error(`cancelling a campaign failed: ${error.message}`);
}

// ---------------------------------------------------------------------------------------------
// What autopost needs to know
// ---------------------------------------------------------------------------------------------

/**
 * For the autopost planner: each campaign still running (any post today or later) with every
 * date it posts on, so autopost leaves the release and those days alone; and every campaign post
 * already sent, as history, so spacing and Instagram's image repeats count them.
 */
export function campaignsForPlan(campaigns: Campaign[], today: string): { campaigns: PlanCampaign[]; history: PastPost[] } {
  const running = campaigns.filter(c => c.posts.some(p => p.postDate >= today));
  const history: PastPost[] = campaigns.flatMap(c => c.posts
    .filter(p => (p.status === 'pushed' || p.status === 'pushing') && p.slotAt)
    .map(p => ({
      at: p.slotAt!,
      kind: 'campaign' as const,
      releaseId: c.releaseId,
      templateIndex: null,
      imageKey: p.imageKey === 'cover' ? `cover:${c.releaseId}` : p.imageKey,
      imageOnInstagram: p.imageKey !== null,
    })));
  return {
    campaigns: running.map(c => ({ releaseId: c.releaseId, dates: c.posts.filter(p => p.status !== 'failed' || p.attempts < MAX_ATTEMPTS).map(p => p.postDate) })),
    history,
  };
}

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

/** Artists with a campaign post waiting to go to Buffer on or before this date (UTC, generous). */
export async function artistsWithCampaignPostsDue(untilDate: string): Promise<string[]> {
  const { data, error } = await client()
    .from('release_campaign_posts')
    .select('artist_id, status, attempts, release_campaigns!inner ( status )')
    .in('status', ['planned', 'failed'])
    .lte('post_date', untilDate)
    .eq('release_campaigns.status', 'active')
    .limit(500);
  if (error) throw new Error(`release_campaign_posts read failed: ${error.message}`);
  const rows = data as unknown as { artist_id: string; status: string; attempts: number }[];
  return [...new Set(rows.filter(r => r.status === 'planned' || r.attempts < MAX_ATTEMPTS).map(r => r.artist_id))];
}

/**
 * Claim a campaign post before calling Buffer, so two runs can never send it twice: a conditional
 * update on the status and attempt count it was read with. True when this run won it.
 */
export async function claimCampaignPost(post: CampaignPost, slotAt: string): Promise<boolean> {
  if (post.status !== 'planned' && !(post.status === 'failed' && post.attempts < MAX_ATTEMPTS)) return false;
  const { data, error } = await client()
    .from('release_campaign_posts')
    .update({ status: 'pushing', attempts: post.attempts + 1, slot_at: slotAt, error: null, updated_at: new Date().toISOString() })
    .eq('id', post.id)
    .eq('status', post.status)
    .eq('attempts', post.attempts)
    .select('id');
  if (error) throw new Error(`claiming a campaign post failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export async function finishCampaignPost(id: string, outcome: {
  status: 'pushed' | 'failed';
  bufferPostIds: CampaignPost['bufferPostIds'];
  captions: CampaignPost['captions'];
  error: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await client()
    .from('release_campaign_posts')
    .update({
      status: outcome.status,
      buffer_post_ids: outcome.bufferPostIds,
      captions: outcome.captions,
      error: outcome.error,
      pushed_at: outcome.status === 'pushed' ? now : null,
      updated_at: now,
    })
    .eq('id', id);
  if (error) throw new Error(`recording a campaign post failed: ${error.message}`);
}
