// The release autopost sweep: hand each artist's next posts to their Buffer
// (docs/specs/release-autopost-spec.md, "How it runs").
//
// Invoked every 6 hours by .github/workflows/release-autopost-sweep.yml, the recatalog-sweep
// precedent: there are no scheduled Netlify functions in this repo. For each artist with
// autopost on, it plans the next PLAN_HORIZON_DAYS with the same pure planner the Promote tab
// shows, and pushes every slot due in the next PUSH_AHEAD_HOURS to Buffer as a scheduled post.
//
// ## Who it posts for
//
// Only an artist whose settings owner still holds the verified claim, and passes the feature
// gate (`canUseReleaseAutopost`): while the `releaseAutopost` flag is off, that's the admin's
// own artists and nobody else's, whatever rows exist.
//
// ## Why it can run twice safely
//
// Each slot is claimed in the database before Buffer is called (`claimSlot`, a unique
// (artist_id, slot_at)), so a second run, or one overlapping this, finds it taken. A run that
// dies between the claim and Buffer leaves the slot claimed: a missed post rather than a doubled
// one. Once a post is in the artist's Buffer, Unstream never edits or deletes it.
//
// ## Why 72 hours ahead
//
// Far inside Buffer's free-plan queue limit (10 scheduled posts per channel), a change in the
// meantime (a release hidden, autopost switched off) is caught before posting, and the artist
// sees every post in Buffer before it goes.
//
// ## Why it returns a real summary
//
// Same reason as recatalog-sweep: a scheduled job that reports success unconditionally is a
// silent failure. The workflow prints the summary and fails on anything but a 200.

import { BANDCAMP_FRIDAY_DATES } from '../shared/bandcamp-friday';
import { AUTOPOST_KINDS, type AutopostKind } from '../shared/autopost-templates';
import { PLAN_HORIZON_DAYS, planSlots, type PlannedPost } from './autopost-plan';
import { buildChannelPost, imageAltText, isAutopostNetwork, variantsFor } from './autopost-channel-post';
import { fitsInstagram, mediaBucketFromEnv, storeImageFromUrl, type MediaBucket, type StoredImage } from './autopost-media';
import {
  claimSlot,
  finishSlot,
  getActiveAutopostSettings,
  getAutopostArtist,
  getAutopostHistory,
  getAutopostReleases,
  getUserEmail,
  pauseAutopost,
  type AutopostArtist,
  type AutopostRelease,
  type AutopostSettings,
  type SlotOutcome,
} from './release-autopost-db';
import { canUseReleaseAutopost } from './release-autopost-access';
import { BufferNotConnectedError, usableAccessToken } from './buffer-db';
import { createPost, ensureTag, listChannels } from './buffer-client';
import { getFeatureFlag } from './feature-flags';
import { getTipsLiveSlugs } from './tips-db';
import { isInternalRequest } from './middleware';
import { Sentry, withSentry } from '../lib/sentry';

export const PUSH_AHEAD_HOURS = 72;

/** The Buffer tag on every autopost, so Buffer's analytics can tell them apart. */
export const AUTOPOST_TAG = { name: 'unstream: release autopost', color: '#2F9E6E' };

/**
 * Start no new artist after this long. An ordinary function has about ten seconds, and one
 * artist with posts due costs a few (an image copy, a Buffer call per channel). Artists not
 * reached wait for the next run, six hours later, well inside the 72 hours their posts are
 * pushed ahead.
 */
const START_BUDGET_MS = 5_000;

interface ArtistResult {
  artistId: string;
  /** Why nothing was pushed for this artist, when that's not simply "nothing due". */
  skipped?: string;
  pushed: number;
  failed: number;
}

/** The URL behind an image key, from what the artist and release rows hold. */
function imageSourceUrl(imageKey: string, artist: AutopostArtist, releases: Map<string, AutopostRelease>): string | null {
  if (imageKey === 'photo') return artist.photoUrl;
  if (imageKey.startsWith('cover:')) return releases.get(imageKey.slice('cover:'.length))?.artworkUrl ?? null;
  // Uploads arrive with Build plan step 4.
  return null;
}

async function takesTips(slug: string): Promise<boolean> {
  if (!(await getFeatureFlag('tipsFans'))) return false;
  return (await getTipsLiveSlugs([slug]))?.has(slug) ?? false;
}

async function pushSlot(
  slot: PlannedPost,
  ctx: {
    settings: AutopostSettings;
    artist: AutopostArtist;
    releases: Map<string, AutopostRelease>;
    channels: { id: string; service: string }[];
    token: string;
    tagId: string;
    tips: boolean;
    bucket: MediaBucket;
  },
): Promise<'pushed' | 'failed' | 'taken'> {
  const { settings, artist, releases } = ctx;
  const id = await claimSlot({
    artistId: artist.id,
    slotAt: slot.at,
    slotDate: slot.date,
    kind: slot.kind,
    releaseId: slot.releaseId,
    templateIndex: slot.templateIndex,
    imageKey: slot.imageKey,
    imageOnInstagram: slot.imageOnInstagram,
  });
  if (!id) return 'taken';

  const release = slot.releaseId ? releases.get(slot.releaseId) ?? null : null;

  // One copy per slot, shared by every channel.
  let image: (StoredImage & { altText: string }) | null = null;
  const imageErrors: string[] = [];
  const source = slot.imageKey ? imageSourceUrl(slot.imageKey, artist, releases) : null;
  if (slot.imageKey && source) {
    try {
      const stored = await storeImageFromUrl(ctx.bucket, source);
      image = { ...stored, altText: imageAltText(slot.imageKey, artist.name, release?.title ?? null) };
    } catch (error) {
      // Posted without it (Instagram skips); reported, since a cover that won't copy is worth knowing.
      imageErrors.push(`Image: ${error instanceof Error ? error.message : String(error)}`);
      Sentry.captureMessage('[release-autopost] image could not be copied', {
        level: 'warning',
        tags: { area: 'release-autopost', kind: 'image-copy' },
        extra: { artistId: artist.id, imageKey: slot.imageKey, error: String(error) },
      });
    }
  }

  const outcome: SlotOutcome = { status: 'failed', bufferPostIds: [], captions: {}, error: null };
  const errors: string[] = [...imageErrors];

  for (const channel of ctx.channels) {
    const post = buildChannelPost({
      slot,
      channel,
      artist: { name: artist.name, slug: artist.slug },
      release,
      templates: settings.templates,
      takesTips: ctx.tips,
      image,
      imageFitsInstagram: image ? fitsInstagram(image) : false,
      tagId: ctx.tagId,
    });
    if (!post.ok) {
      errors.push(`${channel.service}: ${post.reason}`);
      continue;
    }
    try {
      const result = await createPost(ctx.token, post.input);
      const created = result.created[0];
      if (created) {
        outcome.bufferPostIds.push({ channelId: channel.id, postId: created.id });
        outcome.captions[channel.id] = { service: channel.service, text: post.text, imageUrl: post.imageUrl };
      } else {
        errors.push(`${channel.service}: ${result.errors.map(e => e.message).join('; ') || 'Buffer refused the post'}`);
      }
    } catch (error) {
      if (error instanceof BufferNotConnectedError) throw error;
      errors.push(`${channel.service}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Pushed once Buffer took it on any channel. A channel that refused is recorded, not retried:
  // retrying the slot would post again to the channels that accepted it.
  outcome.status = outcome.bufferPostIds.length > 0 ? 'pushed' : 'failed';
  outcome.error = errors.length ? errors.join(' · ') : null;
  await finishSlot(id, outcome);

  if (errors.length) {
    Sentry.captureMessage('[release-autopost] a slot did not reach every channel', {
      level: outcome.status === 'failed' ? 'error' : 'warning',
      tags: { area: 'release-autopost', kind: outcome.status === 'failed' ? 'slot-failed' : 'channel-skipped' },
      extra: { artistId: artist.id, slotAt: slot.at, kind: slot.kind, errors },
    });
  }
  return outcome.status;
}

async function sweepArtist(settings: AutopostSettings, bucket: MediaBucket, now: Date): Promise<ArtistResult> {
  const result: ArtistResult = { artistId: settings.artistId, pushed: 0, failed: 0 };

  // The claim, then the gate: both rechecked every run, never trusted from when it was set up.
  const artist = await getAutopostArtist(settings.artistId);
  if (!artist || artist.verifiedOwnerId !== settings.userId) return { ...result, skipped: 'owner no longer holds the verified claim' };
  if (!(await canUseReleaseAutopost(await getUserEmail(settings.userId)))) return { ...result, skipped: 'not allowed by the releaseAutopost flag' };
  if (!settings.enabledAt || !settings.organizationId || settings.channelIds.length === 0) {
    return { ...result, skipped: 'not set up: no organization or channels' };
  }

  const releases = await getAutopostReleases(artist.id);
  const history = await getAutopostHistory(artist.id, now);
  const plan = planSlots({
    settings: {
      postsPerWeek: settings.postsPerWeek,
      timezone: settings.timezone,
      postTime: settings.postTime,
      enabledAt: settings.enabledAt,
      kindsOff: settings.kindsOff,
      variantCounts: Object.fromEntries(AUTOPOST_KINDS.map(k => [k, variantsFor(k, settings.templates).length])) as Record<AutopostKind, number>,
      // Its shape is checked when it's copied; one outside Instagram's range skips Instagram then.
      artistPhoto: artist.photoUrl ? { instagramOk: true } : null,
      uploadIds: [],
    },
    releases: releases.map(r => ({
      id: r.id,
      releaseDate: r.releaseDate,
      datePrecision: r.datePrecision,
      status: r.status,
      cataloguedAt: r.createdAt,
      onBandcamp: r.sources.some(s => s.platform === 'bandcamp'),
      hasCover: Boolean(r.artworkUrl),
    })),
    history,
    campaigns: [],
    bandcampFridays: BANDCAMP_FRIDAY_DATES,
    from: now.toISOString(),
    to: new Date(now.getTime() + PLAN_HORIZON_DAYS * 86_400_000).toISOString(),
  });

  const pushBefore = now.getTime() + PUSH_AHEAD_HOURS * 3_600_000;
  const due = plan.filter(p => new Date(p.at).getTime() < pushBefore);
  if (due.length === 0) return result;

  let token: string;
  try {
    token = await usableAccessToken(settings.userId);
  } catch (error) {
    if (!(error instanceof BufferNotConnectedError)) throw error;
    await pauseAutopost(artist.id, 'buffer_disconnected');
    return { ...result, skipped: 'Buffer disconnected; paused' };
  }

  // Read from Buffer, not trusted from storage: a channel removed or disconnected there since it
  // was ticked is skipped, never posted to.
  const ticked = new Set(settings.channelIds);
  const channels = (await listChannels(token, settings.organizationId))
    .filter(c => ticked.has(c.id) && !c.isDisconnected && isAutopostNetwork(c.service))
    .map(c => ({ id: c.id, service: c.service }));
  if (channels.length === 0) return { ...result, skipped: 'none of the ticked channels is available in Buffer' };

  const tagId = await ensureTag(token, settings.organizationId, AUTOPOST_TAG.name, AUTOPOST_TAG.color);
  const tips = await takesTips(artist.slug);
  const byId = new Map(releases.map(r => [r.id, r]));

  for (const slot of due) {
    try {
      const status = await pushSlot(slot, { settings, artist, releases: byId, channels, token, tagId, tips, bucket });
      if (status === 'pushed') result.pushed++;
      if (status === 'failed') result.failed++;
    } catch (error) {
      if (error instanceof BufferNotConnectedError) {
        await pauseAutopost(artist.id, 'buffer_disconnected');
        return { ...result, skipped: 'Buffer disconnected mid-run; paused' };
      }
      throw error;
    }
  }
  return result;
}

async function handleRequest(event: { httpMethod?: string; headers?: Record<string, string | undefined> }) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!isInternalRequest(event.headers?.authorization ?? event.headers?.Authorization)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const started = Date.now();
  const now = new Date();
  let settingsList: AutopostSettings[];
  try {
    settingsList = await getActiveAutopostSettings();
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'release-autopost', kind: 'settings-read' } });
    return { statusCode: 503, body: JSON.stringify({ error: 'Could not read autopost settings' }) };
  }

  // Every post may carry an image, and Buffer can only fetch it from the bucket. With anyone to
  // post for, refuse the whole run rather than post without images for a configuration problem.
  // With nobody, there's nothing to refuse: the run is a no-op, not a failure.
  const bucket = mediaBucketFromEnv();
  if ('missing' in bucket && settingsList.length > 0) {
    Sentry.captureMessage('[release-autopost] refused: the media bucket is not configured', {
      level: 'error',
      tags: { area: 'release-autopost', kind: 'bucket-missing' },
      extra: { missing: bucket.missing },
    });
    return { statusCode: 503, body: JSON.stringify({ error: `Media bucket not configured: ${bucket.missing.join(', ')}` }) };
  }

  const summary = { artists: settingsList.length, reached: 0, deferred: 0, pushed: 0, failed: 0, errors: 0, skipped: [] as { artistId: string; reason: string }[] };

  for (const settings of settingsList) {
    if (Date.now() - started > START_BUDGET_MS) {
      summary.deferred++;
      continue;
    }
    summary.reached++;
    try {
      // Narrowed above: with any settings to sweep, a bucket without every setting has returned.
      const r = await sweepArtist(settings, bucket as MediaBucket, now);
      summary.pushed += r.pushed;
      summary.failed += r.failed;
      if (r.skipped) summary.skipped.push({ artistId: r.artistId, reason: r.skipped });
    } catch (error) {
      summary.errors++;
      Sentry.captureException(error, { tags: { area: 'release-autopost', kind: 'artist-failed' }, extra: { artistId: settings.artistId } });
    }
  }

  console.log('[release-autopost-sweep]', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
}

export const handler = withSentry(handleRequest);
