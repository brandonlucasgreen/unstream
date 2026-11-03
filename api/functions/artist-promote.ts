// API endpoint: /api/artist-promote — release autopost settings for one artist, behind the
// Promote page (/promote/:slug). docs/specs/release-autopost-spec.md, "UI: a Promote page".
//
//   GET /api/artist-promote?artist={slug}   settings, the Buffer channels to choose from,
//                                            "Coming up" and "Recent", each post with where it stands
//   GET /api/artist-promote?artist={slug}&part=schedule
//                                            only "Coming up" and "Recent": what the page polls, so
//                                            it doesn't ask Buffer for organizations and channels
//   PUT /api/artist-promote?artist={slug}   save the settings, whole
//
// Two checks, both on every request: the feature gate (`canUseReleaseAutopost`, admin-only while
// the `releaseAutopost` flag is off) and the verified claim (only the artist's own verified owner).
// Everything the browser sends is checked against what Buffer and the database say, so what's
// saved is always something the sweep can act on.

import { buildCorsHeaders, SECOND_FACTOR_REQUIRED_ERROR, sessionMissingSecondFactor } from './middleware';
import { checkRateLimit, getClientIp, resolveAccountRequest } from './ratelimit';
import { canUseReleaseAutopost } from './release-autopost-access';
import {
  getAutopostArtist,
  getAutopostHistory,
  getAutopostReleases,
  getAutopostSettings,
  getAutopostSlotsSince,
  MAX_ATTEMPTS,
  saveAutopostSettings,
  type AutopostArtist,
  type AutopostRelease,
  type AutopostSettings,
} from './release-autopost-db';
import { PUSH_AHEAD_HOURS, planForArtist, toTemplateRelease } from './release-autopost-schedule';
import { isAutopostNetwork, variantsFor } from './autopost-channel-post';
import { addDays, localDate, localInstant, recommendedPostsPerWeek } from './autopost-plan';
import { buildCampaignView, buildScheduleView, type CampaignViewSlot, type LivePosts, type ViewSlot } from './autopost-schedule-view';
import { listAssets, type PromoteAsset } from './promote-assets-db';
import { listCampaigns } from './release-campaigns-db';
import { BufferNotConnectedError, usableAccessToken } from './buffer-db';
import { listChannelPosts, listChannels, listOrganizations } from './buffer-client';
import { getFeatureFlag } from './feature-flags';
import { getTipsLiveSlugs } from './tips-db';
import {
  AUTOPOST_KINDS,
  releaseTemplateVars,
  renderTemplate,
  renderVariant,
  supportTemplateVars,
  templateProblems,
  type AutopostKind,
} from '../shared/autopost-templates';
import { Sentry, withSentry } from '../lib/sentry';

/** Variants an artist may keep per kind, and how long each may be. */
const MAX_VARIANTS = 5;
const MAX_TEMPLATE_LENGTH = 1000;
/** How far back "Recent" looks. */
const RECENT_DAYS = 14;

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
}

/** What a new artist starts from: off, recommended rhythm, Unstream's templates. */
function defaultSettings(artistId: string, userId: string): AutopostSettings {
  return {
    artistId,
    userId,
    enabled: false,
    enabledAt: null,
    postsPerWeek: null,
    timezone: 'America/New_York',
    // "Recommended": the channel's Buffer queue picks the time.
    postTime: null,
    organizationId: null,
    channelIds: [],
    kindsOff: [],
    templates: null,
    pausedReason: null,
  };
}

/** The image behind a key, as the page shows it. `cover` alone is a campaign's own release. */
function imageUrlFor(key: string | null, release: AutopostRelease | null, artist: AutopostArtist, uploads: PromoteAsset[]): string | null {
  if (!key) return null;
  if (key === 'photo') return artist.photoUrl;
  if (key === 'cover' || key.startsWith('cover:')) return release?.artworkUrl ?? null;
  if (key.startsWith('upload:')) return uploads.find(u => `upload:${u.id}` === key)?.url ?? null;
  return null;
}


function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function takesTips(slug: string): Promise<boolean> {
  if (!(await getFeatureFlag('tipsFans'))) return false;
  return (await getTipsLiveSlugs([slug]))?.has(slug) ?? false;
}

/**
 * A usable Buffer token, or null when the account isn't connected. Read once per request and
 * shared: two reads at once could both refresh it, and Buffer revokes a connection whose refresh
 * token is spent twice (usableAccessToken in buffer-db.ts).
 */
async function bufferToken(userId: string): Promise<string | null> {
  try {
    return await usableAccessToken(userId);
  } catch (error) {
    if (error instanceof BufferNotConnectedError) return null;
    throw error;
  }
}

/** The Buffer side of the page: their organizations, and the chosen one's channels. */
async function bufferState(token: string | null, organizationId: string | null) {
  if (!token) return { connected: false as const };
  try {
    const organizations = await listOrganizations(token);
    // Nothing to choose with a single organization, so it's offered already chosen.
    const orgId = organizations.some(o => o.id === organizationId)
      ? organizationId
      : organizations.length === 1 ? organizations[0].id : null;
    const channels = orgId ? (await listChannels(token, orgId)).filter(c => !c.isDisconnected) : [];
    return {
      connected: true as const,
      organizations,
      organizationId: orgId,
      channels: channels.map(c => ({ id: c.id, name: c.name, service: c.service, supported: isAutopostNetwork(c.service) })),
    };
  } catch (error) {
    if (error instanceof BufferNotConnectedError) return { connected: false as const };
    throw error;
  }
}

/**
 * Where each post handed to Buffer stands there now, or null when Buffer can't be asked. Null shows
 * as "in Buffer" without a live status rather than failing the page: the schedule itself doesn't
 * depend on it.
 */
async function livePostStates(token: string | null, organizationId: string | null, stored: { bufferPostIds: { channelId: string }[] }[], since: string): Promise<LivePosts | null> {
  const channelIds = [...new Set(stored.flatMap(s => s.bufferPostIds.map(p => p.channelId)))];
  if (!token || !organizationId || channelIds.length === 0) return null;
  try {
    // A post is created in Buffer up to PUSH_AHEAD_HOURS before its slot, so from that far before.
    const createdSince = new Date(new Date(since).getTime() - PUSH_AHEAD_HOURS * 3_600_000).toISOString();
    const { posts, complete } = await listChannelPosts(token, organizationId, channelIds, createdSince);
    return { posts: new Map(posts.map(p => [p.id, p])), complete };
  } catch (error) {
    if (!(error instanceof BufferNotConnectedError)) {
      Sentry.captureException(error, { tags: { area: 'release-autopost', kind: 'live-post-states' } });
    }
    return null;
  }
}

/**
 * Check a settings body against Buffer and the rules, and return what to save, or what's wrong.
 * Nothing the browser sends is stored without passing through here.
 */
async function validatedSettings(body: Record<string, unknown>, current: AutopostSettings): Promise<{ settings: AutopostSettings } | { error: string; problems?: Record<string, string[]> }> {
  const next: AutopostSettings = { ...current };

  if (typeof body.enabled !== 'boolean') return { error: 'enabled must be true or false' };
  next.enabled = body.enabled;

  if (body.postsPerWeek === null) next.postsPerWeek = null;
  else if (Number.isInteger(body.postsPerWeek) && (body.postsPerWeek as number) >= 1 && (body.postsPerWeek as number) <= 7) next.postsPerWeek = body.postsPerWeek as number;
  else return { error: 'Posts a week must be 1 to 7, or Recommended' };

  if (typeof body.timezone !== 'string' || !isValidTimezone(body.timezone)) return { error: 'That timezone isn’t valid' };
  next.timezone = body.timezone;

  if (body.postTime === null) next.postTime = null;
  else if (typeof body.postTime === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(body.postTime)) next.postTime = body.postTime;
  else return { error: 'Posting time must be HH:MM, or Recommended' };

  const kindsOff = Array.isArray(body.kindsOff) ? body.kindsOff : [];
  if (!kindsOff.every(k => (AUTOPOST_KINDS as readonly unknown[]).includes(k))) return { error: 'Unknown kind of post' };
  next.kindsOff = [...new Set(kindsOff as AutopostKind[])];

  // Templates: only the artist's own variants are stored; a kind left out uses the defaults.
  if (body.templates === null || body.templates === undefined) {
    next.templates = null;
  } else if (typeof body.templates === 'object' && !Array.isArray(body.templates)) {
    const templates: Partial<Record<AutopostKind, string[]>> = {};
    const problems: Record<string, string[]> = {};
    for (const [kind, variants] of Object.entries(body.templates as Record<string, unknown>)) {
      if (!(AUTOPOST_KINDS as readonly string[]).includes(kind)) return { error: `Unknown kind of post: ${kind}` };
      if (!Array.isArray(variants) || variants.length > MAX_VARIANTS || !variants.every(v => typeof v === 'string')) {
        return { error: `Up to ${MAX_VARIANTS} variants for each kind of post` };
      }
      const kept = (variants as string[]).map(v => v.trim()).filter(Boolean);
      const found = kept.flatMap(v => (v.length > MAX_TEMPLATE_LENGTH ? [`Over ${MAX_TEMPLATE_LENGTH} characters`] : templateProblems(v)));
      if (found.length) problems[kind] = [...new Set(found)];
      if (kept.length) templates[kind as AutopostKind] = kept;
    }
    if (Object.keys(problems).length) return { error: 'Some templates need fixing', problems };
    next.templates = Object.keys(templates).length ? templates : null;
  } else {
    return { error: 'templates must be an object' };
  }

  // Buffer: an organization this account belongs to, and channels it has that autopost writes for.
  const organizationId = typeof body.organizationId === 'string' && body.organizationId ? body.organizationId : null;
  const wantedChannels = Array.isArray(body.channelIds) ? body.channelIds.filter((id): id is string => typeof id === 'string') : [];
  if (organizationId) {
    let token: string;
    try {
      token = await usableAccessToken(current.userId);
    } catch (error) {
      if (error instanceof BufferNotConnectedError) return { error: 'Connect Buffer first' };
      throw error;
    }
    const organizations = await listOrganizations(token);
    if (!organizations.some(o => o.id === organizationId)) return { error: 'That isn’t one of your Buffer organizations' };
    const allowed = new Set((await listChannels(token, organizationId))
      .filter(c => !c.isDisconnected && isAutopostNetwork(c.service)).map(c => c.id));
    next.organizationId = organizationId;
    next.channelIds = [...new Set(wantedChannels)].filter(id => allowed.has(id));
  } else {
    next.organizationId = null;
    next.channelIds = [];
  }

  if (next.enabled && (!next.organizationId || next.channelIds.length === 0)) {
    return { error: 'Choose a Buffer organization and at least one channel before switching it on' };
  }

  // Switching on starts the clock for release moments; saving while on keeps it. Saving also
  // clears a pause: the artist acting on the page is the fix, and the sweep pauses again if not.
  if (next.enabled && !current.enabled) next.enabledAt = new Date().toISOString();
  next.pausedReason = null;
  return { settings: next };
}

/**
 * "Coming up" and "Recent": the plan, what the sweep has handed to Buffer, and where each post
 * stands there, with the artist's campaign posts beside autopost's.
 */
async function scheduleState(
  artist: AutopostArtist,
  settings: AutopostSettings,
  token: string | null,
  releases: AutopostRelease[],
  tips: boolean,
  now: Date,
) {
  const today = localDate(now.toISOString(), settings.timezone);
  const since = addDays(today, -RECENT_DAYS);
  const [history, stored, uploads, campaigns] = await Promise.all([
    getAutopostHistory(artist.id, now),
    getAutopostSlotsSince(artist.id, since),
    listAssets(artist.id),
    listCampaigns(artist.id),
  ]);
  const campaignPosts = campaigns.flatMap(c => c.posts
    .filter(p => p.postDate >= since)
    .map(p => ({
      id: p.id,
      step: p.step,
      at: p.slotAt ?? localInstant(p.postDate, settings.postTime ?? '00:00', settings.timezone),
      date: p.postDate,
      releaseId: c.releaseId,
      releaseDate: c.releaseDate,
      imageKey: p.imageKey,
      text: p.text,
      status: p.status,
      attempts: p.attempts,
      error: p.error,
      bufferPostIds: p.bufferPostIds,
      captions: p.captions,
    })));

  // Only asked when something is in Buffer to ask about.
  const inBuffer = [...stored, ...campaignPosts].filter(s => s.status === 'pushed');
  const live = inBuffer.length > 0
    ? await livePostStates(token, settings.organizationId, inBuffer, localInstant(since, '00:00', settings.timezone))
    : null;

  // Before it's switched on, "Coming up" shows what switching on now would post.
  const plan = planForArtist({ ...settings, enabledAt: settings.enabledAt ?? now.toISOString() }, artist, releases, history, { uploads, campaigns }, now);
  const view = buildScheduleView({ plan, stored, live, today, pushAheadHours: PUSH_AHEAD_HOURS, maxAttempts: MAX_ATTEMPTS });
  const campaignView = buildCampaignView({ posts: campaignPosts, live, today, pushAheadHours: PUSH_AHEAD_HOURS, maxAttempts: MAX_ATTEMPTS });

  const byId = new Map(releases.map(r => [r.id, r]));
  /** What was actually sent, once it's in Buffer: the networks other than Instagram, where there's one. */
  const sentCaption = (captions: ViewSlot['captions']) => {
    const sent = captions ? Object.values(captions) : [];
    return sent.find(c => c.service !== 'instagram') ?? sent[0];
  };

  const describe = (slot: ViewSlot) => {
    const release = slot.releaseId ? byId.get(slot.releaseId) ?? null : null;
    const shown = sentCaption(slot.captions);
    let text: string | null;
    if (shown) {
      text = shown.text;
    } else {
      const vars = release
        ? releaseTemplateVars(toTemplateRelease(release), artist, { postDate: slot.date, instagram: false })
        : supportTemplateVars(artist, { takesTips: tips, instagram: false });
      text = renderVariant(variantsFor(slot.kind, settings.templates), slot.templateIndex, vars)?.text ?? null;
    }
    return {
      at: slot.at,
      date: slot.date,
      kind: slot.kind as AutopostKind | 'campaign',
      step: null as string | null,
      release: release ? { title: release.title, slug: release.slug } : null,
      imageUrl: shown?.imageUrl ?? imageUrlFor(slot.imageKey, release, artist, uploads),
      imageOnInstagram: slot.imageOnInstagram,
      text,
      state: slot.state,
    };
  };

  const describeCampaign = (post: CampaignViewSlot & { releaseDate: string }) => {
    const release = byId.get(post.releaseId) ?? null;
    const shown = post.status === 'pushed' ? sentCaption(post.captions) : undefined;
    const text = shown?.text ?? (release
      ? renderTemplate(post.text, releaseTemplateVars(
        { ...toTemplateRelease(release), releaseDate: post.releaseDate, datePrecision: 'day' },
        artist,
        { postDate: post.date, instagram: false },
      ))
      : null);
    return {
      at: post.at,
      date: post.date,
      kind: 'campaign' as const,
      step: post.step,
      release: release ? { title: release.title, slug: release.slug } : null,
      imageUrl: shown?.imageUrl ?? imageUrlFor(post.imageKey, release, artist, uploads),
      imageOnInstagram: post.imageKey !== null,
      text,
      state: post.state,
    };
  };

  const byTime = (a: { at: string }, b: { at: string }) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const releaseDates = new Map(campaignPosts.map(p => [p.id, p.releaseDate]));
  const withDate = (p: CampaignViewSlot) => ({ ...p, releaseDate: releaseDates.get(p.id)! });
  return {
    // `today` is the artist's own date, so the page splits "Coming up" into weeks from their today.
    today,
    comingUp: [...view.upcoming.map(describe), ...campaignView.upcoming.map(p => describeCampaign(withDate(p)))].sort(byTime),
    recent: [...view.recent.map(describe), ...campaignView.recent.map(p => describeCampaign(withDate(p)))].sort(byTime).reverse(),
  };
}

/** Everything the Promote page shows. */
async function pageState(artist: AutopostArtist, settings: AutopostSettings, saved: boolean) {
  const now = new Date();
  const token = await bufferToken(settings.userId);
  const [releases, tips, buffer] = await Promise.all([
    getAutopostReleases(artist.id),
    takesTips(artist.slug),
    bufferState(token, settings.organizationId),
  ]);
  const schedule = await scheduleState(artist, settings, token, releases, tips, now);

  // The newest release, for previewing templates as the artist edits them.
  const newest = [...releases].sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))[0];

  return {
    available: true,
    artist: { name: artist.name, slug: artist.slug, photoUrl: artist.photoUrl },
    saved,
    settings: {
      enabled: settings.enabled,
      enabledAt: settings.enabledAt,
      postsPerWeek: settings.postsPerWeek,
      timezone: settings.timezone,
      postTime: settings.postTime,
      organizationId: settings.organizationId,
      channelIds: settings.channelIds,
      kindsOff: settings.kindsOff,
      templates: settings.templates,
      pausedReason: settings.pausedReason,
    },
    releaseCount: releases.length,
    recommendedPerWeek: recommendedPostsPerWeek(releases.length),
    takesTips: tips,
    previewRelease: newest ? toTemplateRelease(newest) : null,
    buffer,
    ...schedule,
  };
}

/** Only what changes on its own between visits: the schedule, and whether posting stopped. */
async function schedulePart(artist: AutopostArtist, settings: AutopostSettings) {
  const now = new Date();
  const token = await bufferToken(settings.userId);
  const [releases, tips] = await Promise.all([getAutopostReleases(artist.id), takesTips(artist.slug)]);
  return { pausedReason: settings.pausedReason, ...(await scheduleState(artist, settings, token, releases, tips, now)) };
}

async function handleRequest(event: HandlerEvent) {
  const CORS_HEADERS: Record<string, string> = buildCorsHeaders(event.headers.origin || event.headers.Origin, false);
  const respond = (statusCode: number, body: unknown) => ({ statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'PUT') return respond(405, { error: 'Method not allowed' });

  const { key, user } = await resolveAccountRequest(
    event.headers.authorization || event.headers.Authorization || undefined,
    getClientIp(event.headers),
  );
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response as { statusCode: number; headers: Record<string, string>; body: string };
  if (!user) return respond(401, { error: 'Not signed in' });
  if (await sessionMissingSecondFactor(event.headers.authorization || event.headers.Authorization || undefined)) return respond(403, { error: SECOND_FACTOR_REQUIRED_ERROR });

  // The gate first, so nothing about the feature, or the artist, is said to anyone it excludes.
  if (!(await canUseReleaseAutopost(user.email))) return respond(200, { available: false });

  const slug = event.queryStringParameters?.artist;
  if (!slug) return respond(400, { error: 'artist is required' });

  try {
    const artist = await getAutopostArtist({ slug });
    if (!artist) return respond(404, { error: 'Artist not found' });
    if (artist.verifiedOwnerId !== user.userId) return respond(403, { error: 'Only this artist’s verified owner can set this up' });

    const stored = await getAutopostSettings(artist.id);
    // A claim that changed hands: the old owner's settings (and Buffer) are not the new owner's.
    const current = stored && stored.userId === user.userId ? stored : defaultSettings(artist.id, user.userId);

    if (event.httpMethod === 'GET') {
      if (event.queryStringParameters?.part === 'schedule') return respond(200, await schedulePart(artist, current));
      return respond(200, await pageState(artist, current, Boolean(stored)));
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return respond(400, { error: 'Invalid JSON' });
    }
    const result = await validatedSettings(body, current);
    if ('error' in result) return respond(400, result);
    await saveAutopostSettings(result.settings);
    return respond(200, await pageState(artist, result.settings, true));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'release-autopost', kind: `artist-promote:${event.httpMethod}` }, extra: { slug } });
    return respond(500, { error: 'Something went wrong. Try again in a moment.' });
  }
}

export const handler = withSentry(handleRequest);
