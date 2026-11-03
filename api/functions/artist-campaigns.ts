// API endpoint: /api/artist-campaigns — release campaigns, the Campaigns tab of the Promote page
// (docs/specs/release-autopost-spec.md, "Release campaigns"). Brandon, 2026-11-02.
//
//   GET    ?artist={slug}                      the artist's campaigns, the releases they can start
//                                              one for, their images, and where posts go
//   POST   ?artist={slug}&action=propose       Unstream's proposed posts for a release, and the
//          { releaseId, releaseDate, startDate }   autopost days around them. Nothing is saved.
//   POST   ?artist={slug}&action=overlay       the autopost days around an edited set of dates
//          { releaseId, dates, campaignId? }
//   POST   ?artist={slug}                      schedule a campaign: { releaseId, releaseDate, posts }
//   PUT    ?artist={slug}&id={id}              replace its unsent posts: { releaseDate, posts }
//   DELETE ?artist={slug}&id={id}              stop it; posts already in Buffer stay there
//
// Every post is checked here before it's stored: a real step, a date from tomorrow on and none
// shared, words that fill for this release and fit every ticked network, and an image the artist
// has. So what's saved is always something the sweep can send.

import { addDays, daysBetween, localDate, PLAN_HORIZON_DAYS } from './autopost-plan';
import { proposeCampaign } from './campaign-plan';
import { getAutopostHistory, getAutopostReleases, getAutopostSettings, type AutopostArtist, type AutopostRelease, type AutopostSettings } from './release-autopost-db';
import { planForArtist, toTemplateRelease } from './release-autopost-schedule';
import { listAssets, type PromoteAsset } from './promote-assets-db';
import { cancelCampaign, createCampaign, listCampaigns, updateCampaign, type Campaign, type NewPost } from './release-campaigns-db';
import { authorizePromoteRequest, parseBody, type PromoteEvent } from './promote-request';
import { fitsInstagram } from './autopost-media';
import { BufferNotConnectedError, usableAccessToken } from './buffer-db';
import { listChannels } from './buffer-client';
import { AUTOPOST_NETWORK_LIMITS, isAutopostNetwork, isImageFirstNetwork } from '../shared/autopost-networks';
import { releaseTemplateVars, renderTemplate, templateProblems } from '../shared/autopost-templates';
import { isCampaignStep } from '../shared/campaign-steps';
import { BANDCAMP_FRIDAY_DATES } from '../shared/bandcamp-friday';
import { Sentry, withSentry } from '../lib/sentry';

const MAX_POSTS = 20;
const MAX_TEXT_LENGTH = 1000;
/** How far ahead a campaign can reach: release day up to a year out, and its posts after it. */
const MAX_DAYS_AHEAD = 400;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** The artist's own Buffer channels autopost (and so campaigns) post to, or null when there's no connection. */
async function tickedServices(settings: AutopostSettings | null): Promise<string[] | null> {
  if (!settings?.organizationId || settings.channelIds.length === 0) return [];
  try {
    const token = await usableAccessToken(settings.userId);
    const ticked = new Set(settings.channelIds);
    return (await listChannels(token, settings.organizationId))
      .filter(c => ticked.has(c.id) && !c.isDisconnected && isAutopostNetwork(c.service))
      .map(c => c.service);
  } catch (error) {
    if (error instanceof BufferNotConnectedError) return null;
    throw error;
  }
}

/** The artist's own settings, only if they're the current owner's (a claim that changed hands starts afresh). */
async function ownSettings(artistId: string, userId: string): Promise<AutopostSettings | null> {
  const s = await getAutopostSettings(artistId);
  return s && s.userId === userId ? s : null;
}

function releaseShown(r: AutopostRelease) {
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    releaseType: r.releaseType,
    releaseDate: r.releaseDate,
    datePrecision: r.datePrecision,
    status: r.status,
    artworkUrl: r.artworkUrl,
    onBandcamp: r.sources.some(s => s.platform === 'bandcamp'),
    template: toTemplateRelease(r),
  };
}

/**
 * The days autopost posts on around a campaign's dates, so the editor can show how the two fit
 * together. Empty while autopost is off. Reaches past "Coming up"'s four weeks when the campaign
 * does: it's a preview of which days, not a promise of which posts.
 */
function autopostAround(
  ctx: { artist: AutopostArtist; settings: AutopostSettings | null; releases: AutopostRelease[]; history: Awaited<ReturnType<typeof getAutopostHistory>>; uploads: PromoteAsset[]; campaigns: Campaign[] },
  draft: { releaseId: string; dates: string[]; campaignId: string | null },
  now: Date,
): { date: string; kind: string }[] {
  const { settings } = ctx;
  if (!settings?.enabled || !settings.enabledAt || draft.dates.length === 0) return [];
  const today = localDate(now.toISOString(), settings.timezone);
  const last = [...draft.dates].sort().pop()!;
  const horizon = Math.min(MAX_DAYS_AHEAD, Math.max(PLAN_HORIZON_DAYS, daysBetween(today, last) + 8));
  const others = ctx.campaigns.filter(c => c.id !== draft.campaignId);
  const asCampaign: Campaign = {
    id: 'draft', artistId: ctx.artist.id, userId: settings.userId, releaseId: draft.releaseId, releaseDate: last, createdAt: now.toISOString(),
    posts: draft.dates.map((d, i) => ({
      id: `draft-${i}`, campaignId: 'draft', artistId: ctx.artist.id, step: 'custom', postDate: d, text: '', imageKey: null,
      status: 'planned', attempts: 0, slotAt: null, bufferPostIds: [], captions: {}, error: null,
    })),
  };
  return planForArtist({ ...settings, enabledAt: settings.enabledAt }, ctx.artist, ctx.releases, ctx.history,
    { uploads: ctx.uploads, campaigns: [...others, asCampaign] }, now, horizon)
    .map(p => ({ date: p.date, kind: p.kind }));
}

/** Check the posts a campaign is saved with, against the release, the artist's images and channels. */
function validatePosts(
  raw: unknown,
  ctx: { release: AutopostRelease; releaseDate: string; artist: AutopostArtist; uploads: PromoteAsset[]; services: string[]; today: string; sentDates: string[]; otherCampaignDates: string[] },
): { posts: NewPost[] } | { error: string; problems?: Record<number, string[]> } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'A campaign needs at least one post' };
  if (raw.length > MAX_POSTS) return { error: `Up to ${MAX_POSTS} posts in a campaign` };

  const templateRelease = { ...toTemplateRelease(ctx.release), releaseDate: ctx.releaseDate, datePrecision: 'day' };
  const problems: Record<number, string[]> = {};
  const posts: NewPost[] = [];
  const seen = new Set(ctx.sentDates);
  const latest = addDays(ctx.today, MAX_DAYS_AHEAD);

  raw.forEach((item, i) => {
    const found: string[] = [];
    const p = (item ?? {}) as Record<string, unknown>;
    const step = typeof p.step === 'string' && isCampaignStep(p.step) ? p.step : 'custom';
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    const date = p.date;
    const imageKey = typeof p.imageKey === 'string' && p.imageKey ? p.imageKey : null;

    if (!isDate(date)) found.push('Choose a date');
    else if (date <= ctx.today) found.push('Choose a date from tomorrow on');
    else if (date > latest) found.push('That date is too far ahead');
    else if (seen.has(date)) found.push('Another post in this campaign is on this day');
    else if (ctx.otherCampaignDates.includes(date)) found.push('Another campaign posts on this day');
    if (isDate(date)) seen.add(date);

    if (!text) found.push('Write something to post');
    else if (text.length > MAX_TEXT_LENGTH) found.push(`Over ${MAX_TEXT_LENGTH} characters`);
    else {
      const broken = templateProblems(text);
      if (broken.length) found.push(...broken);
      else {
        for (const imageFirst of [false, true]) {
          const filled = renderTemplate(text, releaseTemplateVars(templateRelease, ctx.artist, { postDate: isDate(date) ? date : ctx.today, instagram: imageFirst }));
          if (filled === null) { found.push('Uses a fact Unstream doesn’t have for this release'); break; }
          for (const service of ctx.services.filter(s => isImageFirstNetwork(s) === imageFirst)) {
            if (filled.length > AUTOPOST_NETWORK_LIMITS[service]) found.push(`Too long for ${service} (${filled.length} of ${AUTOPOST_NETWORK_LIMITS[service]})`);
          }
        }
      }
    }

    const imageOk = imageKey === null
      || (imageKey === 'cover' && Boolean(ctx.release.artworkUrl))
      || (imageKey === 'photo' && Boolean(ctx.artist.photoUrl))
      || (imageKey.startsWith('upload:') && ctx.uploads.some(u => `upload:${u.id}` === imageKey));
    if (!imageOk) found.push('That image isn’t available any more');

    if (found.length) problems[i] = [...new Set(found)];
    else posts.push({ step, postDate: date as string, text, imageKey });
  });

  if (Object.keys(problems).length) return { error: 'Some posts need fixing', problems };
  return { posts };
}

async function pageState(artist: AutopostArtist, userId: string, now: Date) {
  const settings = await ownSettings(artist.id, userId);
  const [releases, uploads, campaigns, services, history] = await Promise.all([
    getAutopostReleases(artist.id),
    listAssets(artist.id),
    listCampaigns(artist.id),
    tickedServices(settings),
    getAutopostHistory(artist.id, now),
  ]);
  const timezone = settings?.timezone ?? 'America/New_York';
  const today = localDate(now.toISOString(), timezone);
  const byId = new Map(releases.map(r => [r.id, r]));
  const ctx = { artist, settings, releases, history, uploads, campaigns };

  // Newest first by release date, undated last: a campaign is almost always for the newest.
  const sorted = [...releases].sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || a.title.localeCompare(b.title));

  return {
    available: true,
    artist: { name: artist.name, slug: artist.slug, photoUrl: artist.photoUrl },
    today,
    // Where campaign posts go: the channels ticked on the Autopost tab.
    bufferConnected: services !== null,
    services: services ?? [],
    autopostOn: Boolean(settings?.enabled),
    pausedReason: settings?.pausedReason ?? null,
    releases: sorted.map(releaseShown),
    uploads: uploads.map(u => ({ id: u.id, url: u.url, instagramOk: fitsInstagram(u) })),
    bandcampFridays: BANDCAMP_FRIDAY_DATES,
    campaigns: campaigns.map(c => ({
      id: c.id,
      releaseId: c.releaseId,
      release: byId.get(c.releaseId) ? { title: byId.get(c.releaseId)!.title, artworkUrl: byId.get(c.releaseId)!.artworkUrl } : null,
      releaseDate: c.releaseDate,
      posts: c.posts.map(p => ({ id: p.id, step: p.step, date: p.postDate, text: p.text, imageKey: p.imageKey, status: p.status, error: p.error })),
      autopost: autopostAround(ctx, { releaseId: c.releaseId, dates: c.posts.map(p => p.postDate), campaignId: c.id }, now),
    })),
  };
}

async function handleRequest(event: PromoteEvent) {
  const auth = await authorizePromoteRequest(event, ['GET', 'POST', 'PUT', 'DELETE']);
  if ('response' in auth) return auth.response;
  const { artist, userId, respond } = auth;
  const now = new Date();
  const action = event.queryStringParameters?.action;
  const id = event.queryStringParameters?.id;

  try {
    if (event.httpMethod === 'GET') return respond(200, await pageState(artist, userId, now));

    const campaigns = await listCampaigns(artist.id);
    if (event.httpMethod === 'DELETE') {
      if (!id || !campaigns.some(c => c.id === id)) return respond(404, { error: 'Campaign not found' });
      await cancelCampaign(id);
      return respond(200, await pageState(artist, userId, now));
    }

    const body = parseBody(event);
    if (!body) return respond(400, { error: 'Invalid JSON' });
    const settings = await ownSettings(artist.id, userId);
    const today = localDate(now.toISOString(), settings?.timezone ?? 'America/New_York');
    const [releases, uploads] = await Promise.all([getAutopostReleases(artist.id), listAssets(artist.id)]);

    const existing = event.httpMethod === 'PUT' ? campaigns.find(c => c.id === id) : undefined;
    if (event.httpMethod === 'PUT' && !existing) return respond(404, { error: 'Campaign not found' });
    const releaseId = existing?.releaseId ?? (typeof body.releaseId === 'string' ? body.releaseId : '');
    const release = releases.find(r => r.id === releaseId);
    if (!release) return respond(400, { error: 'Choose one of your releases' });

    if (action === 'overlay') {
      const dates = Array.isArray(body.dates) ? body.dates.filter(isDate).slice(0, MAX_POSTS) : [];
      const history = await getAutopostHistory(artist.id, now);
      const campaignId = typeof body.campaignId === 'string' ? body.campaignId : null;
      return respond(200, { autopost: autopostAround({ artist, settings, releases, history, uploads, campaigns }, { releaseId, dates, campaignId }, now) });
    }

    const releaseDate = body.releaseDate;
    if (!isDate(releaseDate)) return respond(400, { error: 'Choose the release date' });
    if (daysBetween(today, releaseDate) > MAX_DAYS_AHEAD) return respond(400, { error: 'That release date is too far ahead' });

    if (action === 'propose') {
      const startDate = isDate(body.startDate) ? body.startDate : today;
      const posts = proposeCampaign({
        releaseDate,
        startDate,
        today,
        releaseType: release.releaseType,
        preorderOpen: release.status === 'announced',
        onBandcamp: release.sources.some(s => s.platform === 'bandcamp'),
        bandcampFridays: BANDCAMP_FRIDAY_DATES,
        images: { hasCover: Boolean(release.artworkUrl), hasPhoto: Boolean(artist.photoUrl), uploadIds: uploads.map(u => u.id) },
      });
      const history = await getAutopostHistory(artist.id, now);
      const autopost = autopostAround({ artist, settings, releases, history, uploads, campaigns }, { releaseId, dates: posts.map(p => p.date), campaignId: null }, now);
      return respond(200, { posts, autopost });
    }

    if (action) return respond(400, { error: 'Unknown action' });

    // Saving: there has to be somewhere to post.
    const services = await tickedServices(settings);
    if (services === null) return respond(400, { error: 'Reconnect Buffer on the Autopost tab first' });
    if (services.length === 0) return respond(400, { error: 'Choose channels on the Autopost tab first' });

    if (event.httpMethod === 'POST' && campaigns.some(c => c.releaseId === releaseId)) {
      return respond(400, { error: 'This release already has a campaign' });
    }
    const sent = existing?.posts.filter(p => p.status === 'pushing' || p.status === 'pushed') ?? [];
    const otherCampaignDates = campaigns.filter(c => c.id !== existing?.id).flatMap(c => c.posts.map(p => p.postDate));
    const result = validatePosts(body.posts, {
      release, releaseDate, artist, uploads, services, today, sentDates: sent.map(p => p.postDate), otherCampaignDates,
    });
    if ('error' in result) return respond(400, result);

    if (existing) {
      await updateCampaign(existing.id, releaseDate, result.posts);
    } else {
      const created = await createCampaign({ artistId: artist.id, userId, releaseId, releaseDate, posts: result.posts });
      if (!created) return respond(400, { error: 'This release already has a campaign' });
    }
    return respond(200, await pageState(artist, userId, now));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'release-autopost', kind: `artist-campaigns:${event.httpMethod}` }, extra: { artistId: artist.id, action } });
    return respond(500, { error: 'Something went wrong. Try again in a moment.' });
  }
}

export const handler = withSentry(handleRequest);
