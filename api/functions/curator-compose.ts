// API endpoint: POST /api/curator/{preview,cards,send} — composing a curator's post
// (docs/specs/curator-posts-spec.md). Admin only for the hackathon cut, the way tips were.
//
//   POST /api/curator/preview   each network's caption, its tags and what's missing. No Buffer
//                               call, no cards drawn — this runs on every keystroke's debounce.
//   POST /api/curator/cards     draw one slide, store it in R2, return its public URL.
//   POST /api/curator/send      create the posts in Buffer from card URLs already stored.
//
// **Everything is rebuilt here from artist slugs.** Handles, payouts, links and card contents
// never come from the browser: the page can say *which* artists and *what the curator wrote*,
// and nothing else. A browser that could name a payout could put a false one on a card carrying
// Unstream's logo.

import { getArtistsBySlugs } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import {
  addPostToContentItem,
  bufferOrgId,
  createContentItem,
  createPost,
  ensureTag,
  listChannels,
  type BufferChannel,
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
import { renderCuratorCard } from '../../scripts/social-card-render';
import { cardBucketFromEnv, publishCard } from '../../scripts/social-cards';
import { Sentry, withSentry } from '../lib/sentry';
import { createHash } from 'node:crypto';

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
  channels?: Record<string, unknown>;
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

/** The curator's own framing, as typed. Unstream supplies no default show name. */
function profileFrom(body: ComposeBody): CuratorProfile {
  return {
    showName: str(body.curator?.showName),
    labelName: str(body.curator?.labelName),
    handles: {
      instagram: str(body.curator?.handles?.instagram),
      facebook: str(body.curator?.handles?.facebook),
    },
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
  const CORS_HEADERS = buildCorsHeaders(event.headers.origin || event.headers.Origin, false);
  const respond = (statusCode: number, body: unknown) => ({ statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  // Admin only while this is unreleased, the same gate tips shipped behind.
  const admin = await authenticateAdmin(event.headers.authorization || event.headers.Authorization || undefined);
  if (!admin) return respond(401, { error: 'Unauthorized' });

  const orgId = bufferOrgId();
  if (!orgId) return respond(200, { available: false });

  let body: ComposeBody;
  try {
    body = JSON.parse(event.body || '{}') as ComposeBody;
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  const action = actionFrom(event);
  const template = templateFrom(body);
  const curator = profileFrom(body);
  const book = addressBookFrom(body);

  try {
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
      const who = createHash('sha256').update(admin.userId).digest('hex').slice(0, 16);
      const digest = createHash('sha256').update(png).digest('hex').slice(0, 32);
      const url = await publishCard(bucket, `curator/${who}/${digest}.png`, png);
      return respond(200, { url, altText: curatorCardAltText(data) });
    }

    if (action === 'send') return await send(body, { orgId, artists, template, curator, book, respond });

    return respond(404, { error: 'Unknown action' });
  } catch (error) {
    Sentry.captureException(error, { tags: { curator_action: action } });
    return respond(500, { error: error instanceof Error ? error.message : 'Something went wrong' });
  }
}

interface SendContext {
  orgId: string;
  artists: CuratorArtist[];
  template: CuratorTemplate;
  curator: CuratorProfile;
  book: AddressBook;
  respond: (statusCode: number, body: unknown) => { statusCode: number; headers: Record<string, string>; body: string };
}

/**
 * Create the posts in Buffer.
 *
 * Instagram is created on its own and then added to Facebook's content item, as the weekly
 * generator does: a content item is all-or-nothing, and a rejected Instagram variant inside one
 * would cost the Facebook post too. So **a failed Instagram post must not take Facebook down
 * with it** — the two are reported separately and the grouping is best-effort.
 */
async function send(body: ComposeBody, ctx: SendContext) {
  const { orgId, artists, template, curator, book, respond } = ctx;

  const cardUrls = Array.isArray(body.cardUrls) ? body.cardUrls.filter((u): u is string => typeof u === 'string') : [];
  const bucket = cardBucketFromEnv();
  // Only cards this endpoint stored: the public bucket host, under the curator's own prefix.
  // Without this the browser could hand Buffer any URL to publish under Unstream's name.
  const prefix = `${bucket.publicBaseUrl}/curator/`;
  if (cardUrls.some(u => !u.startsWith(prefix))) return respond(400, { error: 'A card URL is not one of ours' });
  if (cardUrls.length === 0) return respond(400, { error: 'No cards to send' });

  const channels = await listChannels(orgId);
  const pick = (network: CuratorNetwork): BufferChannel | null => {
    const wanted = str(body.channels?.[network]);
    const usable = channels.filter(c => c.service === network && !c.isDisconnected);
    return (wanted ? usable.find(c => c.id === wanted) : usable[0]) ?? null;
  };

  const saveToDraft = str(body.mode) !== 'now';
  const tagId = await ensureTag(orgId, CURATOR_TAG.name, CURATOR_TAG.color);
  const title = curator.showName ?? `${artists.length} artists on Unstream`;

  const results: Record<string, { postId?: string; status?: string; error?: string }> = {};
  let contentItemId: string | undefined;

  // Facebook first, as the content item: if Instagram fails, Facebook has already gone.
  const facebook = pick('facebook');
  if (facebook) {
    const caption = renderCaption({ template, artists, network: 'facebook', curator, addressBook: book });
    const problem = captionProblem('facebook', caption);
    if (problem) {
      results.facebook = { error: problem };
    } else {
      const item = await createContentItem(orgId, title, [tagId], [{
        channelId: facebook.id,
        text: caption,
        schedulingType: 'automatic',
        saveToDraft,
        ...(saveToDraft ? {} : { mode: 'shareNow' }),
        tagIds: [tagId],
        assets: cardUrls.map(url => ({ image: { url, metadata: { altText: 'Card from Unstream' } } })),
        metadata: { facebook: { type: 'post' } },
      }]);
      contentItemId = item.contentItemId;
      results.facebook = item.created[0]
        ? { postId: item.created[0].id, status: item.created[0].status }
        : { error: item.errors.map(e => e.message).join('; ') };
    }
  }

  const instagram = pick('instagram');
  if (instagram) {
    const preview = previewFor('instagram', artists, template, curator, book);
    if (preview.problem) {
      results.instagram = { error: preview.problem };
    } else {
      const post = await createPost({
        channelId: instagram.id,
        text: preview.caption,
        schedulingType: 'automatic',
        saveToDraft,
        ...(saveToDraft ? {} : { mode: 'shareNow' }),
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
      results.instagram = post.created[0]
        ? { postId: post.created[0].id, status: post.created[0].status }
        : { error: post.errors.map(e => e.message).join('; ') };
    }
  }

  // Grouping only — the posts are created and tagged either way, so a failure here is reported
  // but doesn't fail the send.
  let grouping: string | null = null;
  if (contentItemId && results.instagram?.postId) {
    grouping = await addPostToContentItem(contentItemId, results.instagram.postId);
  }

  const sent = Object.values(results).filter(r => r.postId).length;
  return respond(sent > 0 ? 200 : 502, { results, grouping, draft: saveToDraft, contentItemId: contentItemId ?? null });
}

export const handler = withSentry(handleRequest);
