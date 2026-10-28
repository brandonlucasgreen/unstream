// API endpoint: POST /api/curator/{preview,cards,send} — composing a curator's post
// (docs/specs/curator-posts-spec.md).
//
// Open to any signed-in curator who has connected their own Buffer account, behind the
// `curatorPosts` flag, which fails closed (the admin account is let through regardless, to test
// it). Each curator posts from their own tokens: there is no shared account, and nothing here
// reads a token from the environment.
//
//   POST /api/curator/preview   each network's caption, its tags and what's missing. No Buffer
//                               call, no cards drawn — this runs on every keystroke's debounce.
//   POST /api/curator/cards     draw one slide, store it in R2, return its public URL.
//   POST /api/curator/send      create the posts in Buffer from card URLs already stored, on the
//                               channels the curator ticked (/api/me/buffer/channels).
//
// **Everything is rebuilt here from artist slugs.** Handles, payouts, links and card contents
// never come from the browser: the page can say *which* artists and *what the curator wrote*,
// and nothing else. A browser that could name a payout could put a false one on a card carrying
// Unstream's logo.

import { getArtistsBySlugs, getPublicUsername } from './db';
import { buildCorsHeaders } from './middleware';
import { checkRateLimit, getClientIp, resolveAccountRequest } from './ratelimit';
import { BufferNotConnectedError, canUseCuratorPosts, getBufferConnection, usableAccessToken } from './buffer-db';
import {
  addPostToContentItem,
  createContentItem,
  createPost,
  ensureTag,
  listChannels,
} from './buffer-client';
import {
  captionProblem,
  cleanHashtags,
  handleFor,
  isValidHandle,
  linkUrlFor,
  renderCaption,
  sellingPlatformFrom,
  type AddressBook,
  type CuratorArtist,
  type CuratorNetwork,
  type CuratorProfile,
  type CuratorTemplate,
} from './curator-posts';
import { curatorCardAltText, MAX_CURATOR_ARTIST_CARDS, type CuratorCardArtist, type CuratorCardData } from '../shared/curator-card';
import { PLATFORMS } from '../shared/platform-registry';
import { CARD_FONT_FILES, loadCardAssetsWith, renderCuratorCard } from '../../scripts/social-card-render';
import { cardBucketFromEnv, publishCard } from '../../scripts/social-cards';
import { Sentry, withSentry } from '../lib/sentry';
import { createHash } from 'node:crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

// The renderer finds its fonts through import.meta.url, which is EMPTY in this function's
// bundle: Netlify builds it as CommonJS despite "type": "module". So they're found through
// __dirname and require instead, exactly as api/functions/social-card.ts does.
// netlify.toml's included_files puts scripts/social-card-fonts/ in the zip at the same place
// relative to this file as in the repo, and external_node_modules ships resvg whole, so both
// paths hold deployed and under vitest, which provides the same globals.
//
// Nothing in the test suite catches this: the tests mock the renderer, and under tsx and vitest
// import.meta.url works. It fails only when a card is drawn in production.
loadCardAssetsWith(() => ({
  fonts: CARD_FONT_FILES.map(file => readFileSync(join(__dirname, '..', '..', 'scripts', 'social-card-fonts', file))),
  wasm: readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')),
}));

/** One Buffer tag for everything this feature creates, so its analytics stand apart. */
const CURATOR_TAG = { name: 'unstream: curator', color: '#00C8CF' };

const NETWORKS: CuratorNetwork[] = ['instagram', 'facebook'];

/** Instagram tags every slide from the first image's tags, so they all go on the cover. */
const TAG_GRID = [
  { x: 0.25, y: 0.3 }, { x: 0.5, y: 0.3 }, { x: 0.75, y: 0.3 },
  { x: 0.25, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.5 },
  { x: 0.25, y: 0.7 }, { x: 0.5, y: 0.7 }, { x: 0.75, y: 0.7 },
];

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string | null;
  path?: string;
  rawUrl?: string;
}

interface ComposeBody {
  artists?: { slug?: unknown; release?: unknown }[];
  template?: { postText?: unknown; lineText?: unknown; hashtags?: unknown };
  curator?: { showName?: unknown; labelName?: unknown; handles?: Record<string, unknown> };
  /** Handles the curator typed in, keyed by artist slug. Used for this post only. */
  handles?: Record<string, Record<string, unknown>>;
  slide?: unknown;
  artistSlug?: unknown;
  cardUrls?: unknown;
  mode?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The action, from the path rather than the body.
 *
 * Read from `rawUrl` first: under a netlify.toml splat rewrite the function sees the original
 * public path there, and `queryStringParameters` is empty whatever the rewrite's target says
 * (see api/functions/__tests__ and the release-detail incident).
 */
function actionFrom(event: HandlerEvent): string {
  const raw = event.rawUrl ? (() => { try { return new URL(event.rawUrl).pathname; } catch { return event.path ?? ''; } })() : (event.path ?? '');
  return raw.replace(/\/+$/, '').split('/').pop() ?? '';
}

/**
 * The curator's own framing. The show name is as typed, and Unstream supplies no default. Their
 * Instagram handle is the name of the Instagram channel the page has ticked, which only signs
 * their own cards. Their Unstream username is read here, never taken from the page, because it
 * becomes a link in the caption.
 */
function profileFrom(body: ComposeBody, unstreamHandle: string | null): CuratorProfile {
  return {
    showName: str(body.curator?.showName),
    labelName: str(body.curator?.labelName),
    handles: {
      instagram: str(body.curator?.handles?.instagram),
      facebook: str(body.curator?.handles?.facebook),
    },
    unstreamHandle,
  };
}

function templateFrom(body: ComposeBody): CuratorTemplate {
  return {
    postText: typeof body.template?.postText === 'string' ? body.template.postText : '',
    lineText: typeof body.template?.lineText === 'string' ? body.template.lineText : '',
    hashtags: Array.isArray(body.template?.hashtags)
      ? body.template.hashtags.filter((t): t is string => typeof t === 'string')
      : [],
  };
}

/** Typed-in handles, kept only when they're shaped like a handle for their own network. */
function addressBookFrom(body: ComposeBody): AddressBook {
  const book: AddressBook = {};
  for (const [slug, byNetwork] of Object.entries(body.handles ?? {})) {
    for (const network of NETWORKS) {
      const typed = str(byNetwork?.[network]);
      if (typed && isValidHandle(network, typed)) {
        book[slug] = { ...book[slug], [network]: typed };
      }
    }
  }
  return book;
}

/**
 * The artists, read from the database by slug — one query however many were mentioned.
 *
 * The release is the one the curator picked, else the one the artist's own selling link knows
 * about. The release *catalogue* is deliberately not queried: that would be a read per artist on
 * every preview keystroke, and search was cut off from driving per-artist reads for exactly that
 * reason (see "Budgets" in the spec).
 */
async function loadArtists(body: ComposeBody): Promise<{ artists: CuratorArtist[]; missing: string[] }> {
  const requested = (body.artists ?? [])
    .map(a => ({ slug: str(a?.slug), release: str(a?.release) }))
    .filter((a): a is { slug: string; release: string | null } => a.slug !== null);

  if (requested.length === 0) return { artists: [], missing: [] };

  const found = await getArtistsBySlugs(requested.map(a => a.slug));
  const artists: CuratorArtist[] = [];
  const missing: string[] = [];

  for (const { slug, release } of requested) {
    const row = found.get(slug);
    if (!row) { missing.push(slug); continue; }

    const links = row.platforms ?? [];
    const picked = sellingPlatformFrom(links);
    const city = row.location?.city || row.location?.country || null;

    artists.push({
      // The slug is the identifier through this whole flow: it is what /api/suggest returns,
      // what the page sends back, and what keys the typed-in handles.
      id: row.slug,
      name: row.name,
      slug: row.slug,
      location: city,
      links: { instagram: linkUrlFor(links, 'instagram'), facebook: linkUrlFor(links, 'facebook') },
      release: release ? { title: release } : picked.release,
      platform: picked.platform,
    });
  }
  return { artists, missing };
}

/** One artist as the card renderer wants them, for the network being drawn. */
function cardArtist(artist: CuratorArtist, network: CuratorNetwork, book: AddressBook): CuratorCardArtist {
  return {
    name: artist.name,
    location: artist.location,
    release: artist.release?.title ?? null,
    payout: artist.platform ? PLATFORMS[artist.platform.id]?.payoutPercent ?? null : null,
    platformName: artist.platform?.name ?? null,
    // Only Instagram tags, so only Instagram gets a bubble (see curator-posts.ts).
    handle: network === 'instagram' ? handleFor(artist, network, book) : null,
  };
}

interface NetworkPreview {
  caption: string;
  /** Instagram only: who the cover will tag, and where. */
  tags: { handle: string; x: number; y: number }[];
  /** Artists this network can't tag, by name. Normal, not an error. */
  untagged: string[];
  problem: string | null;
}

function previewFor(
  network: CuratorNetwork,
  artists: CuratorArtist[],
  template: CuratorTemplate,
  curator: CuratorProfile,
  book: AddressBook,
): NetworkPreview {
  const caption = renderCaption({ template, artists, network, curator, addressBook: book });

  const handles = network === 'instagram'
    ? artists.map(a => ({ name: a.name, handle: handleFor(a, network, book) }))
    : artists.map(a => ({ name: a.name, handle: null }));

  const tags = handles
    .filter((h): h is { name: string; handle: string } => h.handle !== null)
    .slice(0, TAG_GRID.length)
    .map((h, i) => ({ handle: h.handle, ...TAG_GRID[i] }));

  return {
    caption,
    tags,
    untagged: handles.filter(h => !h.handle).map(h => h.name),
    problem: captionProblem(network, caption),
  };
}

async function handleRequest(event: HandlerEvent) {
  const CORS_HEADERS: Record<string, string> = buildCorsHeaders(event.headers.origin || event.headers.Origin, false);
  const respond = (statusCode: number, body: unknown) => ({ statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  const { key, user } = await resolveAccountRequest(
    event.headers.authorization || event.headers.Authorization || undefined,
    getClientIp(event.headers),
  );
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response as { statusCode: number; headers: Record<string, string>; body: string };
  if (!user) return respond(401, { error: 'Not signed in' });

  // The flag gates the whole feature and fails closed, so an unset flag hides it rather than
  // half-opening it. The admin is let through regardless, to test it before it is switched on.
  if (!(await canUseCuratorPosts(user.email))) return respond(200, { available: false });

  // The curator's own connection. No connection means the page should offer to make one, which
  // is a normal state rather than an error. Connected with no organization chosen means the page
  // is asking which; nothing posts until it has an answer.
  const connection = await getBufferConnection(user.userId);
  if (!connection) return respond(200, { available: true, connected: false });
  if (!connection.organizationId) return respond(409, { error: 'Choose a Buffer organization first' });
  const orgId = connection.organizationId;

  let body: ComposeBody;
  try {
    body = JSON.parse(event.body || '{}') as ComposeBody;
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  const action = actionFrom(event);
  const template = templateFrom(body);
  const book = addressBookFrom(body);

  try {
    // Only captions use it, and a card is drawn ten times a send, so cards don't read it.
    const curator = profileFrom(body, action === 'cards' ? null : await getPublicUsername(user.userId));
    const { artists, missing } = await loadArtists(body);
    if (artists.length === 0) return respond(400, { error: 'No artists we hold were named', missing });

    if (action === 'preview') {
      const networks: Record<string, NetworkPreview> = {};
      for (const network of NETWORKS) networks[network] = previewFor(network, artists, template, curator, book);
      return respond(200, {
        available: true,
        networks,
        missing,
        hashtags: cleanHashtags(template.hashtags),
        artists: artists.map(a => ({
          slug: a.slug,
          name: a.name,
          release: a.release?.title ?? null,
          payout: a.platform ? PLATFORMS[a.platform.id]?.payoutPercent ?? null : null,
          platform: a.platform?.name ?? null,
          handles: {
            instagram: handleFor(a, 'instagram', book),
            // Not a tag: Facebook Page mentions need a numeric Page id we don't hold, so this
            // only says we know their page. See the spec's "What goes to Buffer".
            facebook: handleFor(a, 'facebook', book),
          },
        })),
        tooManyForOneCarousel: artists.length > MAX_CURATOR_ARTIST_CARDS,
      });
    }

    if (action === 'cards') {
      const slide = str(body.slide);
      if (slide !== 'cover' && slide !== 'curator-artist') return respond(400, { error: 'Unknown slide' });

      const frame = { kicker: curator.showName, viaHandle: curator.handles.instagram ?? null };
      let data: CuratorCardData;
      if (slide === 'cover') {
        data = { slide, frame, artists: artists.slice(0, MAX_CURATOR_ARTIST_CARDS).map(a => cardArtist(a, 'instagram', book)) };
      } else {
        const wanted = str(body.artistSlug);
        const one = artists.find(a => a.slug === wanted);
        if (!one) return respond(400, { error: 'That artist is not in this post' });
        data = { slide, frame, artist: cardArtist(one, 'instagram', book) };
      }

      const png = await renderCuratorCard(data);
      const bucket = cardBucketFromEnv();
      // The curator's own prefix, so one curator's cards can't land among another's or among
      // the weekly generator's.
      const who = createHash('sha256').update(user.userId).digest('hex').slice(0, 16);
      const digest = createHash('sha256').update(png).digest('hex').slice(0, 32);
      const url = await publishCard(bucket, `curator/${who}/${digest}.png`, png);
      return respond(200, { url, altText: curatorCardAltText(data) });
    }

    if (action === 'send') {
      return await send(body, {
        orgId, userId: user.userId, selectedChannelIds: connection.selectedChannelIds, artists, template, curator, book, respond,
      });
    }

    return respond(404, { error: 'Unknown action' });
  } catch (error) {
    // Buffer revoked us, or the grant expired. The page asks them to reconnect; this is not a
    // server error and must not be retried.
    if (error instanceof BufferNotConnectedError) {
      return respond(200, { available: true, connected: false, reason: error.message });
    }
    Sentry.captureException(error, { tags: { curator_action: action } });
    return respond(500, { error: error instanceof Error ? error.message : 'Something went wrong' });
  }
}

interface SendContext {
  orgId: string;
  userId: string;
  /** What the curator ticked, as stored — the page doesn't get to name channels at send time. */
  selectedChannelIds: string[];
  artists: CuratorArtist[];
  template: CuratorTemplate;
  curator: CuratorProfile;
  book: AddressBook;
  respond: (statusCode: number, body: unknown) => { statusCode: number; headers: Record<string, string>; body: string };
}

interface ChannelResult {
  service: string;
  name: string;
  postId?: string;
  status?: string;
  error?: string;
}

/**
 * Create the posts in Buffer, one per ticked channel.
 *
 * Facebook Pages go in one content item; each Instagram post is created on its own and then
 * added to it, as the weekly generator does. A content item is all-or-nothing, and a rejected
 * Instagram variant inside one would cost the Facebook posts too. So **a failed Instagram post
 * must not take Facebook down with it** — every channel is reported separately and the grouping
 * is best-effort.
 */
async function send(body: ComposeBody, ctx: SendContext) {
  const { orgId, userId, selectedChannelIds, artists, template, curator, book, respond } = ctx;

  // Refreshed if need be, and never read straight from storage: Buffer's access tokens last an
  // hour and its refresh tokens are single-use (see buffer-db.ts).
  const token = await usableAccessToken(userId);

  const cardUrls = Array.isArray(body.cardUrls) ? body.cardUrls.filter((u): u is string => typeof u === 'string') : [];
  const bucket = cardBucketFromEnv();
  // Only cards this endpoint stored: the public bucket host, under the curator's own prefix.
  // Without this the browser could hand Buffer any URL to publish under Unstream's name.
  const prefix = `${bucket.publicBaseUrl}/curator/`;
  if (cardUrls.some(u => !u.startsWith(prefix))) return respond(400, { error: 'A card URL is not one of ours' });
  if (cardUrls.length === 0) return respond(400, { error: 'No cards to send' });

  // Read from Buffer again rather than trusted from storage: a channel disconnected since it was
  // ticked is skipped, not posted to.
  const ticked = new Set(selectedChannelIds);
  const channels = (await listChannels(token, orgId))
    .filter(c => ticked.has(c.id) && !c.isDisconnected && (c.service === 'instagram' || c.service === 'facebook'));
  if (channels.length === 0) return respond(400, { error: 'Choose at least one channel to post to' });

  const saveToDraft = str(body.mode) !== 'now';
  const tagId = await ensureTag(token, orgId, CURATOR_TAG.name, CURATOR_TAG.color);
  const title = curator.showName ?? `${artists.length} artists on Unstream`;
  const shareMode = saveToDraft ? {} : { mode: 'shareNow' };

  const results: Record<string, ChannelResult> = {};
  for (const c of channels) results[c.id] = { service: c.service, name: c.name };
  let contentItemId: string | undefined;

  // Facebook first, as the content item: if Instagram fails, Facebook has already gone.
  const facebook = channels.filter(c => c.service === 'facebook');
  if (facebook.length > 0) {
    const caption = renderCaption({ template, artists, network: 'facebook', curator, addressBook: book });
    const problem = captionProblem('facebook', caption);
    if (problem) {
      for (const c of facebook) results[c.id].error = problem;
    } else {
      const item = await createContentItem(token, orgId, title, [tagId], facebook.map(c => ({
        channelId: c.id,
        text: caption,
        schedulingType: 'automatic',
        saveToDraft,
        ...shareMode,
        tagIds: [tagId],
        assets: cardUrls.map(url => ({ image: { url, metadata: { altText: 'Card from Unstream' } } })),
        metadata: { facebook: { type: 'post' } },
      })));
      contentItemId = item.contentItemId;
      const general = item.errors.filter(e => !e.channelId).map(e => e.message).join('; ');
      for (const c of facebook) {
        const created = item.created.find(p => p.channelId === c.id);
        const own = item.errors.filter(e => e.channelId === c.id).map(e => e.message).join('; ');
        if (created) Object.assign(results[c.id], { postId: created.id, status: created.status });
        else results[c.id].error = own || general || 'Not created';
      }
    }
  }

  const instagram = channels.filter(c => c.service === 'instagram');
  if (instagram.length > 0) {
    const preview = previewFor('instagram', artists, template, curator, book);
    for (const c of instagram) {
      if (preview.problem) { results[c.id].error = preview.problem; continue; }
      const post = await createPost(token, {
        channelId: c.id,
        text: preview.caption,
        schedulingType: 'automatic',
        saveToDraft,
        ...shareMode,
        tagIds: [tagId],
        assets: cardUrls.map((url, i) => ({
          image: {
            url,
            metadata: {
              altText: 'Card from Unstream',
              // Instagram applies the first image's tags to every slide, so they all go here.
              ...(i === 0 && preview.tags.length ? { userTags: preview.tags } : {}),
            },
          },
        })),
        metadata: { instagram: { type: 'post', shouldShareToFeed: true } },
      });
      if (post.created[0]) Object.assign(results[c.id], { postId: post.created[0].id, status: post.created[0].status });
      else results[c.id].error = post.errors.map(e => e.message).join('; ') || 'Not created';
    }
  }

  // Grouping only — the posts are created and tagged either way, so a failure here is reported
  // but doesn't fail the send.
  const groupingErrors: string[] = [];
  for (const c of instagram) {
    const postId = results[c.id].postId;
    if (!contentItemId || !postId) continue;
    const problem = await addPostToContentItem(token, contentItemId, postId);
    if (problem) groupingErrors.push(problem);
  }

  const sent = Object.values(results).filter(r => r.postId).length;
  return respond(sent > 0 ? 200 : 502, {
    results,
    grouping: groupingErrors.length ? groupingErrors.join('; ') : null,
    draft: saveToDraft,
    contentItemId: contentItemId ?? null,
  });
}

export const handler = withSentry(handleRequest);
