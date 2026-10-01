/**
 * Generate and optionally schedule the week's social posts. The copy itself lives in
 * scripts/social-post-templates.ts; this file picks the artists, gathers their data and talks to
 * Buffer.
 *
 * The week, on Threads and Bluesky:
 *   Mon, Tue, Wed, Fri, Sat  a verified indie artist (the posts that get reposted)
 *   Thu                      one prominent artist, framed around what a purchase is worth
 *   Sat, one week in three   a plain question instead of the spotlight
 *   Sun                      a maker post about Unstream, or a shipped feature
 * The Unstream LinkedIn page gets two posts: Tue (economics) and Thu (the week's artists).
 * Instagram gets the indie spotlights only, as carousels of cards Unstream draws itself
 * (/api/social-card, docs/specs/instagram-original-posts-spec.md), in the same Buffer content
 * item as that day's Threads and Bluesky posts.
 * docs/engineering-history.md ("Social posts") has the measurements behind that shape.
 *
 * Output:
 *   data/social-posts/{week}/drafts.json   - All drafts for the week
 *   data/social-posts/{week}/day-{n}.md    - Human-readable draft per day
 *   data/social-posts/history.json         - Tracks which artists have been featured
 *
 * Usage:
 *   npx tsx scripts/generate-social-posts.ts                        # Current week
 *   npx tsx scripts/generate-social-posts.ts --week 2026-W13        # Specific week
 *   npx tsx scripts/generate-social-posts.ts --schedule              # Push to Buffer as DRAFTS (requires approval)
 *   npx tsx scripts/generate-social-posts.ts --schedule --publish    # Push to Buffer for auto-publication
 *   npx tsx scripts/generate-social-posts.ts --channels              # List Buffer channel IDs
 *
 * Exits non-zero when any post was too long to send or Buffer rejected it, after the rest have
 * been scheduled and history saved — a rejected post used to leave the run green.
 *
 * Environment:
 *   BUFFER_ACCESS_TOKEN   - Required for --schedule and --channels
 *   BUFFER_ORG_ID         - Required for --schedule (content items belong to an organization) and --channels
 *   BUFFER_CHANNEL_IDS    - Required for --schedule (comma-separated: threads,bluesky,instagram,linkedin).
 *                           Positional; leave a slot empty to skip that platform (e.g. "t,b,,l").
 *   SUPABASE_URL          - Optional (falls back to production API)
 *   SUPABASE_SERVICE_KEY  - Optional (falls back to production API)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isExcludedArtistSlug } from '../api/lib/excluded-artists';
import { BANDCAMP_FRIDAY_DATES } from '../api/shared/bandcamp-friday';
import { PLATFORMS } from '../api/shared/platform-registry';
import { isSearchUrl, pickCatalogueRelease, type CatalogueRelease } from '../api/shared/social-card';
import {
  CHARACTER_LIMITS,
  UNSTREAM_BASE,
  bandcampMatchesArtist,
  featurePost,
  indieSpotlight,
  isQuestionWeek,
  linkedinRoundup,
  linkedinWeekdayPost,
  makerPost,
  questionPost,
  recordMath,
  type ArtistContext,
  type Platform,
  type SellingPlatform,
  type ShippedFeature,
  type SocialPost,
} from './social-post-templates';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SOCIAL_DIR = join(DATA_DIR, 'social-posts');
const MANIFEST_PATH = join(DATA_DIR, 'artists-manifest.json');
const ARTIST_LIST_PATH = join(DATA_DIR, 'artist-list.json');
const HISTORY_PATH = join(SOCIAL_DIR, 'history.json');

// Non-music Wikidata occupation QIDs — same list used in generate-artist-list.ts
// Non-music Wikidata occupation QIDs — same list used in generate-artist-list.ts
const NON_MUSIC_OCCUPATIONS = [
  'Q245068',   // comedian
  'Q33999',    // actor
  'Q10800557', // film actor
  'Q10798782', // television actor
  'Q2405480',  // voice actor
  'Q947873',   // television presenter
  'Q82955',    // politician
  'Q2526255',  // film director
  'Q28389',    // screenwriter
  'Q36180',    // writer
  'Q49757',    // poet
  'Q15214752', // podcaster
  'Q170790',   // mathematician
  'Q901',      // scientist
  'Q2066131',  // athlete
  'Q937857',   // football player
];

// Hardcoded exclusions — safety net for when Wikidata queries fail (502s, timeouts).
// These are non-music artists who have Bandcamp pages for unrelated people with the same name.
const MANUAL_EXCLUDE_SLUGS = new Set([
  'lenny-bruce',       // deceased comedian, Bandcamp page is a different person
]);

// --- Types ---

interface ManifestArtist {
  name: string;
  slug: string;
  imageUrl: string;
  platformCount: number;
  lastUpdated: string;
}

interface ArtistPlatform {
  sourceId: string;
  url: string;
  latestRelease?: {
    title: string;
    type: string;
    url: string;
    imageUrl?: string;
    releaseDate?: string;
  };
}

interface ArtistData {
  id: string;
  name: string;
  type: string;
  imageUrl: string;
  platforms: ArtistPlatform[];
}

interface VerifiedArtist {
  slug: string;
  name: string;
  imageUrl: string | null;
}

interface SocialHandles {
  threads: string | null;   // without the @, e.g. "tommorello"
  bluesky: string | null;   // e.g. "tommorelloofficial.bsky.social"
  instagram: string | null; // without the @
}

type DayKind = 'indie' | 'record-math' | 'question' | 'maker' | 'feature';

/** Posts about one subject. Two or more go to Buffer as a single content item. */
interface PostGroup {
  title: string;
  tag: TagKey;
  posts: SocialPost[];
}

// One Buffer tag per kind of post, so Buffer's analytics can compare them. Prefixed because the
// organization's tags are shared with Brandon's other channels. ensureTags creates any that are
// missing, so renaming one here starts a new tag rather than renaming the old.
const TAGS = {
  indie: { name: 'unstream: indie spotlight', color: '#FF702C' },
  'record-math': { name: 'unstream: record math', color: '#FADE2A' },
  conversation: { name: 'unstream: conversation', color: '#00C8CF' },
  mission: { name: 'unstream: mission', color: '#D7AAFF' },
  feature: { name: 'unstream: feature', color: '#CFE7A6' },
  roundup: { name: 'unstream: roundup', color: '#F3AFB9' },
} as const;
type TagKey = keyof typeof TAGS;

const TAG_FOR_KIND: Record<DayKind, TagKey> = {
  indie: 'indie',
  'record-math': 'record-math',
  question: 'conversation',
  maker: 'mission',
  feature: 'feature',
};

interface DayDraft {
  day: number; // 1-7 (Mon-Sun)
  date: string; // YYYY-MM-DD
  kind: DayKind;
  artistName: string | null;
  artistSlug: string | null;
  groups: PostGroup[];
}

interface History {
  featured: string[]; // slugs
  lastUpdated: string;
}

// --- Platforms ---

// Platforms that sell music, so a post can say "buy it there". Patronage platforms (Patreon,
// Ko-fi, Buy Me a Coffee) can't headline a post for that reason.
const SELLING_PLATFORMS = new Set(['bandcamp', 'faircamp', 'mirlo', 'qobuz', 'ampwall', 'bandwagon', 'jamcoop']);

/**
 * The artist's first selling link in display order, with its registry payout and a record of
 * theirs that's there: from their release catalogue when there is one (verified artists), else
 * the link's own latestRelease (the generated files the prominent artists come from).
 */
function sellingPlatform(
  platforms: ArtistPlatform[],
  artistName: string,
  catalogue: CatalogueRelease[]
): SellingPlatform | null {
  const link = platforms.find(p => SELLING_PLATFORMS.has(p.sourceId) && !isSearchUrl(p.url));
  if (!link) return null;
  const meta = PLATFORMS[link.sourceId];
  const linkTitle = link.latestRelease ? cleanReleaseTitle(link.latestRelease.title, artistName) : null;
  const linkRelease = linkTitle && link.latestRelease
    ? { title: linkTitle, type: link.latestRelease.type, latest: true, slug: null, artworkUrl: null }
    : null;
  return {
    id: link.sourceId,
    name: meta?.name ?? link.sourceId,
    payout: meta?.payoutPercent ?? null,
    release: pickCatalogueRelease(catalogue, link.sourceId) ?? linkRelease,
  };
}

// --- Social handle extraction ---

/**
 * Handles (without the @) from the artist's own social links. Each is used only on its own
 * network: an Instagram handle on Threads lost its @ when Threads couldn't resolve it (see
 * threadsName in social-post-templates.ts).
 */
function extractSocialHandles(platforms: ArtistPlatform[]): SocialHandles {
  const findUrl = (sourceId: string) =>
    platforms.find(p => p.sourceId === sourceId)?.url || null;

  return {
    threads: parseThreadsHandle(findUrl('threads')),
    bluesky: parseBlueskyHandle(findUrl('bluesky')),
    instagram: parseInstagramHandle(findUrl('instagram')),
  };
}

/** "kidlightbulbs" from instagram.com/kidlightbulbs/, ignoring share parameters (?igsh=). */
function parseInstagramHandle(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'instagram.com' && !parsed.hostname.endsWith('.instagram.com')) return null;
    const segment = parsed.pathname.replace(/^\/|\/$/g, '').split('/')[0].replace(/^@/, '');
    // Post, reel and story links name no account. Instagram handles are letters, digits, . and _.
    if (['p', 'reel', 'reels', 'explore', 'stories', 'tv'].includes(segment)) return null;
    return /^[A-Za-z0-9._]{1,30}$/.test(segment) ? segment : null;
  } catch { return null; }
}

function parseThreadsHandle(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('threads.net') && !parsed.hostname.includes('threads.com')) return null;
    // Path: /@username or /username
    const segment = parsed.pathname.replace(/^\/|\/$/g, '').split('/')[0];
    if (!segment) return null;
    const handle = segment.startsWith('@') ? segment.slice(1) : segment;
    if (!handle) return null;
    return handle;
  } catch { return null; }
}

function parseBlueskyHandle(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // Only accept bsky.app/profile/... URLs (rejects garbage like share links)
    if (parsed.hostname !== 'bsky.app') return null;
    const match = parsed.pathname.match(/^\/profile\/([^/]+)/);
    if (!match) return null;
    const handle = match[1];
    // Basic sanity: handle should contain a dot (e.g. user.bsky.social or custom.domain)
    if (!handle.includes('.')) return null;
    return handle;
  } catch { return null; }
}

/**
 * Clean up release titles — source data (especially Qobuz) often appends artist
 * names, has excess whitespace, or includes other artifacts.
 * Returns null if the title is too garbled to use.
 */
function cleanReleaseTitle(title: string, artistName: string): string | null {
  // Collapse all whitespace (newlines, tabs, multiple spaces) into single spaces
  let cleaned = title.replace(/\s+/g, ' ').trim();

  // Remove all occurrences of the artist name (case-insensitive)
  // Qobuz data often embeds artist names: "To All My Friends Xavier Cugat Xavier Cugat Orchestra"
  const artistPattern = new RegExp(`\\b${artistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  cleaned = cleaned.replace(artistPattern, '').replace(/\s+/g, ' ').trim();

  // If title is still very long (>60 chars), it's probably garbled data — skip it
  if (cleaned.length > 60) return null;

  // If nothing meaningful left after cleanup, skip
  if (cleaned.length < 2) return null;

  return cleaned;
}

function artistContext(
  artist: { name: string; slug: string; imageUrl: string | null },
  url: string,
  platforms: ArtistPlatform[],
  location: string | null,
  catalogue: CatalogueRelease[]
): ArtistContext {
  const handles = extractSocialHandles(platforms);
  return {
    name: artist.name,
    slug: artist.slug,
    url,
    imageUrl: artist.imageUrl,
    location,
    threadsHandle: handles.threads,
    blueskyHandle: handles.bluesky,
    instagramHandle: handles.instagram,
    platform: sellingPlatform(platforms, artist.name, catalogue),
  };
}

// --- Shipped features ---

const SHIPPED_FEATURES_PATH = join(DATA_DIR, 'shipped-features.json');

function loadShippedFeatures(): ShippedFeature[] {
  if (!existsSync(SHIPPED_FEATURES_PATH)) return [];
  return JSON.parse(readFileSync(SHIPPED_FEATURES_PATH, 'utf-8'));
}

function markFeatureAnnounced(featureId: string) {
  const features = loadShippedFeatures();
  const feature = features.find(f => f.id === featureId);
  if (feature) {
    feature.announced = true;
    writeFileSync(SHIPPED_FEATURES_PATH, JSON.stringify(features, null, 2));
  }
}

// --- Data loading ---

function loadHistory(): History {
  if (existsSync(HISTORY_PATH)) {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'));
  }
  return { featured: [], lastUpdated: new Date().toISOString() };
}

function saveHistory(history: History) {
  history.lastUpdated = new Date().toISOString();
  if (!existsSync(SOCIAL_DIR)) mkdirSync(SOCIAL_DIR, { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function loadManifest(): ManifestArtist[] {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

interface ArtistListEntry {
  name: string;
  slug: string;
  musicbrainzId: string;
}

function loadArtistList(): ArtistListEntry[] {
  if (!existsSync(ARTIST_LIST_PATH)) return [];
  return JSON.parse(readFileSync(ARTIST_LIST_PATH, 'utf-8'));
}

/**
 * Query Wikidata for the artists these posts must not feature, by MusicBrainz ID:
 *
 *   * non-music artists — comedians, actors, athletes, whose Bandcamp page is usually a different
 *     person with the same name;
 *   * artists who have died. Every post says some variant of "support them directly", and 107 of
 *     the artists in this pool are dead. Five had already gone out — Sara Tavares, Dusty Hill,
 *     Brook Benton, Lhasa de Sela and Lex Barker — before anything checked.
 *
 * Returns the slugs to exclude plus whether the lookup was **complete**. That flag is the point:
 * every batch here is wrapped in a try/catch that warns and moves on, so a Wikidata outage used
 * to produce an empty exclusion set, which reads identically to "nobody needs excluding" and
 * would let exactly the posts this guards against go out. A failed lookup is not a negative
 * result; the caller drops the pool rather than trusting a partial answer.
 *
 * Runs a single SPARQL query in batches to stay within Wikidata limits.
 */
async function findExcludedArtists(
  artistList: ArtistListEntry[]
): Promise<{ slugs: Set<string>; complete: boolean }> {
  const excludeSlugs = new Set<string>();
  let complete = true;
  const mbidToSlug = new Map(artistList.map(a => [a.musicbrainzId, a.slug]));

  // Process in batches of 200 (Wikidata VALUES clause limit)
  const BATCH_SIZE = 150;
  const mbids = artistList.map(a => a.musicbrainzId);
  const totalBatches = Math.ceil(mbids.length / BATCH_SIZE);

  for (let i = 0; i < mbids.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = mbids.slice(i, i + BATCH_SIZE);
    const valuesClause = batch.map(id => `"${id}"`).join(' ');

    const occupationValues = NON_MUSIC_OCCUPATIONS.map(q => `wd:${q}`).join(' ');
    // One query, two reasons to exclude: a non-music occupation (P106) or a date of death (P570).
    // Matched through the artist's own MusicBrainz ID (P434), never by name — a name match pairs
    // "Sebastian Bach" with Johann Sebastian Bach and "Jack White" with a footballer.
    const sparql = `
SELECT DISTINCT ?mbid WHERE {
  VALUES ?mbid { ${valuesClause} }
  ?artist wdt:P434 ?mbid .
  {
    VALUES ?nonMusicOccupation { ${occupationValues} }
    ?artist wdt:P106 ?nonMusicOccupation .
  } UNION {
    ?artist wdt:P570 ?dateOfDeath .
  }
}`;

    try {
      const url = 'https://query.wikidata.org/sparql';
      // Use POST to avoid URL length limits with large VALUES clauses
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'Unstream/1.0 (https://unstream.stream; support@unstream.stream)',
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/sparql-results+json',
        },
        body: new URLSearchParams({ query: sparql }),
        signal: AbortSignal.timeout(60000),
      });

      if (res.ok) {
        const data = await res.json();
        const found = data.results.bindings.length;
        if (found > 0) {
          for (const binding of data.results.bindings) {
            const mbid = binding.mbid?.value;
            if (mbid) {
              const slug = mbidToSlug.get(mbid);
              if (slug) excludeSlugs.add(slug);
            }
          }
        }
      } else {
        console.warn(`  ⚠ Wikidata batch ${batchNum}/${totalBatches} returned ${res.status}`);
        complete = false;
      }
    } catch (err) {
      console.warn(`  ⚠ Wikidata batch ${batchNum}/${totalBatches} failed: ${err instanceof Error ? err.message : err}`);
      complete = false;
    }

    // Be nice to Wikidata
    if (i + BATCH_SIZE < mbids.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return { slugs: excludeSlugs, complete };
}

function loadArtistData(slug: string): ArtistData | null {
  const path = join(DATA_DIR, 'artists', `${slug}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return Array.isArray(data) ? data[0] : data;
}

async function fetchVerifiedArtists(): Promise<VerifiedArtist[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('⚠ SUPABASE_URL/SUPABASE_SERVICE_KEY not set — fetching from production API');
    const res = await fetch(`${UNSTREAM_BASE}/api/artist-directory`);
    const data = await res.json();
    return data.artists || [];
  }

  // Use the Supabase REST API directly to avoid importing the client
  const profilesRes = await fetch(
    `${supabaseUrl}/rest/v1/artist_profiles?verified_at=not.is.null&select=artist_id,custom_image_url`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
  );
  const profiles = await profilesRes.json();
  if (!profiles?.length) return [];

  const artistIds = profiles.map((p: { artist_id: string }) => p.artist_id);
  const artistsRes = await fetch(
    `${supabaseUrl}/rest/v1/artists?id=in.(${artistIds.join(',')})&select=id,name,slug,image_url`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
  );
  const artists = await artistsRes.json();

  const customImages = new Map(
    profiles.filter((p: { custom_image_url: string }) => p.custom_image_url)
      .map((p: { artist_id: string; custom_image_url: string }) => [p.artist_id, p.custom_image_url])
  );

  return (artists || []).map((a: { id: string; slug: string; name: string; image_url: string }) => ({
    slug: a.slug,
    name: a.name,
    imageUrl: customImages.get(a.id) || a.image_url || null,
  }));
}

async function fetchCanonicalSlugs(): Promise<Map<string, string>> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const canonical = new Map<string, string>();
  if (!supabaseUrl || !supabaseKey) {
    console.warn('⚠ SUPABASE_URL/SUPABASE_SERVICE_KEY not set — retired slugs are not re-pointed (they still resolve via the redirect)');
    return canonical;
  }

  // Same REST-direct pattern as fetchVerifiedArtists above. Manifest slugs can be retired
  // (accent re-slugs, merges), and a post advertising /artist/trentem-ller only works as long
  // as the redirect installed for crawlers exists — the sitemap re-points the same slugs, so
  // posts must too. An empty map on failure is the graceful answer: posts go out on the
  // redirecting slug rather than the run failing.
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/artist_slug_aliases?select=alias,artists!inner(slug)`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    const rows = await res.json() as Array<{ alias: string; artists: { slug: string } | null }> | null;
    if (!Array.isArray(rows)) {
      console.warn('⚠ Alias lookup returned no rows — posts keep the manifest slug.');
      return canonical;
    }
    for (const row of rows) {
      if (row.alias && row.artists?.slug) canonical.set(row.alias, row.artists.slug);
    }
  } catch (error) {
    console.warn(`⚠ Alias lookup failed (${error instanceof Error ? error.message : error}) — posts keep the manifest slug.`);
  }
  return canonical;
}

interface IndieLookup {
  platforms: ArtistPlatform[];
  location: string | null;
  releases: CatalogueRelease[];
}

/**
 * A verified artist's links, location and release catalogue in one request, from the same public
 * endpoint the artist page uses (`/api/artist-page`; the owner-only `/api/artist-releases` needs
 * a session). Its links leave out junk search links, the releases come in the artist's own order
 * and then newest first, and hidden releases are already gone.
 *
 * Null means the lookup failed, which is not the same as "nowhere to buy" — the caller skips the
 * artist either way, but says which.
 */
async function fetchIndieArtist(slug: string): Promise<IndieLookup | null> {
  try {
    const res = await fetch(`${UNSTREAM_BASE}/api/artist-page?slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = await res.json() as {
      artist?: { city?: string | null; country?: string | null };
      links?: { platform: string; url: string }[];
      socialLinks?: { platform: string; url: string }[];
      releases?: CatalogueRelease[];
    };
    const links = [...(data.links || []), ...(data.socialLinks || [])];
    return {
      platforms: links.map(l => ({ sourceId: l.platform, url: l.url })),
      location: data.artist?.city || data.artist?.country || null,
      releases: data.releases || [],
    };
  } catch {
    return null;
  }
}

/**
 * The Instagram post with only the cards that render, checked by fetching each one from the live
 * endpoint: the same request Buffer makes when the post publishes, so it also warms the CDN for
 * it. A card can fail for reasons only the renderer knows (a photo host off the allowlist, a WebP
 * it can't decode, an image host that's down), and Buffer would otherwise only find out on
 * publish day and fail the post there. Null when no card renders.
 */
async function withRenderableCards(post: SocialPost, artistName: string): Promise<SocialPost | null> {
  const rendered = await Promise.all(post.images.map(async image => {
    const card = new URL(image.url).pathname.split('/').pop();
    try {
      const res = await fetch(image.url, { signal: AbortSignal.timeout(30000) });
      await res.arrayBuffer();
      if (res.ok && res.headers.get('content-type') === 'image/png') return true;
      console.log(`    · ${artistName}: Instagram card ${card} didn't render (${res.status}), so it's left out`);
    } catch (error) {
      console.log(`    · ${artistName}: Instagram card ${card} didn't render (${error instanceof Error ? error.message : error}), so it's left out`);
    }
    return false;
  }));

  const kept = post.images.filter((_, i) => rendered[i]).map(image => ({ url: image.url, altText: image.altText }));
  if (kept.length === 0) return null;
  // The tag goes on whichever card is now first; on a carousel the first image's tags apply to all.
  const tags = post.images[0].userTags;
  return { ...post, images: tags ? [{ ...kept[0], userTags: tags }, ...kept.slice(1)] : kept };
}

// --- Week calculation ---

function getWeekDates(weekStr?: string): { week: string; dates: string[] } {
  let startDate: Date;

  if (weekStr) {
    // Parse ISO week: 2026-W13
    const [yearStr, weekNumStr] = weekStr.split('-W');
    const year = parseInt(yearStr);
    const weekNum = parseInt(weekNumStr);
    // Find Jan 4 (always in week 1), then offset
    const jan4 = new Date(year, 0, 4);
    const dayOfWeek = jan4.getDay() || 7; // Mon=1..Sun=7
    startDate = new Date(jan4);
    startDate.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
  } else {
    // Current week (start on Monday)
    const now = new Date();
    const day = now.getDay() || 7;
    startDate = new Date(now);
    startDate.setDate(now.getDate() - day + 1);
  }

  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  // Compute ISO week string
  const thu = new Date(startDate);
  thu.setDate(startDate.getDate() + 3);
  const yearStart = new Date(thu.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((thu.getTime() - yearStart.getTime()) / 86400000 + yearStart.getDay() + 1) / 7);
  const week = `${thu.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

  return { week, dates };
}

// --- Artist selection ---

// Slugs to deprioritize — these are "us" and shouldn't appear in the first cycle.
// They'll still be featured eventually once the pool cycles.
const DEPRIORITIZE_SLUGS = new Set(['kid-lightbulbs']);

// Generic over the pool entry so the caller keeps any extra fields (the prominent pool carries
// `manifestSlug` alongside the re-pointed slug).
function pickArtist<T extends { slug: string; name: string; imageUrl: string | null }>(
  pool: T[],
  history: History
): T | null {
  // Prefer artists not yet featured
  let unfeatured = pool.filter(a => !history.featured.includes(a.slug));

  // On the first pass through the pool, deprioritize our own project(s)
  if (unfeatured.length > 1) {
    const withoutSelf = unfeatured.filter(a => !DEPRIORITIZE_SLUGS.has(a.slug));
    if (withoutSelf.length > 0) unfeatured = withoutSelf;
  }

  if (unfeatured.length > 0) {
    const idx = Math.floor(Math.random() * unfeatured.length);
    return unfeatured[idx];
  }

  // Everyone's been featured — reset history and start a new cycle
  if (pool.length > 0) {
    history.featured = [];
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx];
  }

  return null;
}

// How many artists a slot tries before giving up on it: each failed try is an artist with nowhere
// to buy, or a lookup that failed, and those are skipped for the rest of the run.
const MAX_PICK_ATTEMPTS = 8;

/** Artists this run has already used up: featured in an earlier slot, or skipped. */
interface RunPicks {
  featured: Set<string>;
  skipped: Set<string>;
}

/**
 * Pick an artist for a slot and build their posts, moving on to another artist when `build`
 * returns null. Only an artist who actually gets posts is marked featured.
 *
 * Nobody already featured or skipped this run is offered again. Without that, a pool whose only
 * unfeatured artists were skipped ones made pickArtist start a new cycle, and the same artist went
 * out four days running. A new cycle also empties history, so this week's earlier picks are put
 * back afterwards; otherwise next week could pick them again.
 */
async function pickSpotlight<T extends { slug: string; name: string; imageUrl: string | null }>(
  pool: T[],
  history: History,
  run: RunPicks,
  build: (artist: T) => Promise<{ context: ArtistContext; posts: SocialPost[] } | null>
): Promise<{ artist: T; context: ArtistContext; posts: SocialPost[] } | null> {
  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    const artist = pickArtist(pool.filter(a => !run.featured.has(a.slug) && !run.skipped.has(a.slug)), history);
    if (!artist) return null;
    const built = await build(artist);
    if (built) {
      run.featured.add(artist.slug);
      for (const slug of run.featured) {
        if (!history.featured.includes(slug)) history.featured.push(slug);
      }
      return { artist, ...built };
    }
    run.skipped.add(artist.slug);
  }
  return null;
}

// --- Buffer GraphQL integration ---
// Uses Buffer's GraphQL API at https://api.buffer.com
// Docs: https://developers.buffer.com

const BUFFER_GRAPHQL = 'https://api.buffer.com';

async function bufferGraphQL(query: string, variables?: Record<string, unknown>) {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) throw new Error('BUFFER_ACCESS_TOKEN not set');

  const res = await fetch(BUFFER_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();

  if (!res.ok || data.errors) {
    const errMsg = data.errors?.map((e: { message: string }) => e.message).join('; ') || JSON.stringify(data);
    throw new Error(`Buffer API error (${res.status}): ${errMsg}`);
  }

  return data;
}

async function listChannels() {
  const orgId = process.env.BUFFER_ORG_ID;
  if (!orgId) {
    console.error('\n✗ BUFFER_ORG_ID not set. Find it in your Buffer settings URL.');
    process.exit(1);
  }

  const result = await bufferGraphQL(`
    query GetChannels($orgId: ID!) {
      channels(input: { organizationId: $orgId }) {
        id
        name
        service
      }
    }
  `, { orgId });

  const channels = result.data?.channels || [];
  console.log('\nBuffer channels:\n');
  for (const c of channels) {
    console.log(`  ${c.service} — ${c.name} (ID: ${c.id})`);
  }
  console.log('\nSet these IDs in the BUFFER_CHANNEL_IDS env var (comma-separated).');
  console.log('Order: threads,bluesky,instagram,linkedin\n');
}

// Threads, Bluesky and Instagram at 9am ET (8am in winter), LinkedIn on weekday afternoons,
// where its engagement peaks.
const POST_TIME_UTC: Record<Platform, string> = { threads: '13:00', bluesky: '13:00', instagram: '13:00', linkedin: '20:00' };

/**
 * Instagram posts dated before this go to Buffer as drafts even on a --publish run, so the first
 * week of cards is looked at in Buffer before any goes out on its own. That week is 2026-W42,
 * generated on Monday 5 October; if this ships after that run, move the date on a week.
 */
const INSTAGRAM_DRAFTS_BEFORE = '2026-10-19';

function lengthProblem(post: SocialPost): string | null {
  const limit = CHARACTER_LIMITS[post.platform];
  return post.text.length > limit ? `${post.text.length}/${limit} characters` : null;
}

/**
 * Each tag's Buffer id, creating any tag the organization doesn't have yet. Run before anything
 * is generated: a failure here should stop the run while there is still nothing to roll back.
 */
async function ensureTags(organizationId: string): Promise<Record<TagKey, string>> {
  const existing = new Map<string, string>();
  let after: string | null = null;
  do {
    const result = await bufferGraphQL(`
      query Tags($organizationId: OrganizationId!, $after: String) {
        tagsV2(input: { organizationId: $organizationId }, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { id name } }
        }
      }
    `, { organizationId, after });
    const page = result.data.tagsV2;
    for (const edge of page.edges) existing.set(edge.node.name, edge.node.id);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  const ids = {} as Record<TagKey, string>;
  for (const key of Object.keys(TAGS) as TagKey[]) {
    const { name, color } = TAGS[key];
    const found = existing.get(name);
    if (found) {
      ids[key] = found;
      continue;
    }
    const result = await bufferGraphQL(`
      mutation CreateTag($input: CreateTagInput!) {
        createTag(input: $input) {
          ... on TagActionSuccess { tag { id } }
          ... on MutationError { message }
        }
      }
    `, { input: { organizationId, tag: { name, color } } });
    const created = result.data.createTag;
    if (!created?.tag) throw new Error(`Couldn't create the Buffer tag "${name}": ${created?.message ?? 'unknown error'}`);
    console.log(`  Created Buffer tag "${name}"`);
    ids[key] = created.tag.id;
  }
  return ids;
}

/** Buffer's CreatePostInput for one post. createPost and createContentItem both take it. */
function postInput(post: SocialPost, channelId: string, date: string, saveToDraft: boolean, tagId: string): Record<string, unknown> {
  const input: Record<string, unknown> = {
    channelId,
    text: post.text,
    dueAt: `${date}T${POST_TIME_UTC[post.platform]}:00Z`,
    schedulingType: 'automatic',
    mode: 'customScheduled',
    saveToDraft,
    // On every post, not only the content item: Buffer doesn't pass an item's tags down to its
    // posts, and analytics filter on the posts' own tags.
    tagIds: [tagId],
    assets: post.images.map(image => ({
      image: { url: image.url, metadata: { altText: image.altText, ...(image.userTags ? { userTags: image.userTags } : {}) } },
    })),
  };
  if (post.platform === 'threads') input.metadata = { threads: { topic: 'Music Threads' } };
  if (post.platform === 'instagram') input.metadata = { instagram: { type: 'post', shouldShareToFeed: true } };
  if (post.platform === 'linkedin' && post.firstComment) input.metadata = { linkedin: { firstComment: post.firstComment } };
  return input;
}

interface BufferResult {
  created: { id: string; status: string; channelId: string }[];
  /** channelId is set when the error belongs to one channel's post. */
  errors: { channelId?: string; message: string }[];
  /** Set when a content item was created. */
  contentItemId?: string;
}

async function createBufferPost(input: Record<string, unknown>): Promise<BufferResult> {
  const result = await bufferGraphQL(`
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            status
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `, { input });

  const data = result.data?.createPost;
  if (data?.post) {
    return { created: [{ id: data.post.id, status: data.post.status, channelId: String(input.channelId) }], errors: [] };
  }
  return { created: [], errors: [{ channelId: String(input.channelId), message: data?.message || 'Unknown error' }] };
}

/**
 * One subject on several channels, created as one Buffer content item holding a post per
 * channel, so Buffer shows it as one piece of content. Validation is all-or-nothing: an invalid
 * variant creates nothing, which is why over-long posts are dropped before this is called.
 * (createContentItem is an early-preview API; createPost stays in use for single posts.)
 */
async function createBufferContentItem(
  organizationId: string,
  title: string,
  targetDate: string,
  tagId: string,
  posts: Record<string, unknown>[]
): Promise<BufferResult> {
  const result = await bufferGraphQL(`
    mutation CreateContentItem($input: CreateContentItemInput!) {
      createContentItem(input: $input) {
        ... on CreateContentItemSuccess {
          content {
            id
            body {
              ... on PostContent { posts { id status channelId } }
            }
          }
        }
        ... on CreateContentItemFailure {
          message
          errors {
            ... on CreateContentItemVariantInvalidInputError { channelId message }
            ... on CreateContentItemVariantLimitReachedError { channelId message }
            ... on CreateContentItemVariantNotFoundError { channelId message }
            ... on InvalidInputError { message }
            ... on LimitReachedError { message }
            ... on NotFoundError { message }
          }
        }
      }
    }
  `, { input: { organizationId, title, targetDate, tagIds: [tagId], posts } });

  const data = result.data?.createContentItem;
  const created = data?.content?.body?.posts ?? [];
  if (data?.content) return { created, errors: [], contentItemId: data.content.id };

  const errors: BufferResult['errors'] = data?.errors ?? [];
  return { created, errors: errors.length ? errors : [{ message: data?.message || 'Unknown error' }] };
}

/**
 * Put a post that already exists into a content item, so Buffer shows the day's posts together.
 * Returns the error, or null. Only the grouping is at stake: the post is already scheduled and
 * tagged either way.
 */
async function addPostToContentItem(contentItemId: string, postId: string): Promise<string | null> {
  try {
    const result = await bufferGraphQL(`
      mutation AddPostToContentItem($input: AddPostToContentItemInput!) {
        addPostToContentItem(input: $input) {
          ... on AddPostToContentItemSuccess { post { id } }
          ... on VoidMutationError { message }
        }
      }
    `, { input: { id: contentItemId, postId } });
    const data = result.data?.addPostToContentItem;
    return data?.post ? null : (data?.message || 'Unknown error');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// --- Markdown output ---

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const KIND_LABELS: Record<DayKind, string> = {
  indie: 'Indie spotlight',
  'record-math': 'Record math (prominent artist)',
  question: 'Question',
  maker: 'Maker post',
  feature: 'Feature announcement',
};

const PLATFORM_LABELS: Record<Platform, string> = { threads: 'Threads', bluesky: 'Bluesky', instagram: 'Instagram', linkedin: 'LinkedIn' };

function draftToMarkdown(draft: DayDraft): string {
  const header = [
    `# ${DAY_NAMES[draft.day - 1]}, ${draft.date}: ${KIND_LABELS[draft.kind]}`,
    draft.artistName ? `\n**Artist:** ${draft.artistName} (${draft.artistSlug})` : '',
  ].join('');

  const sections = draft.groups.map(group => {
    const posts = group.posts.map(post => {
      const lines = [
        `### ${PLATFORM_LABELS[post.platform]} (${post.text.length}/${CHARACTER_LIMITS[post.platform]} chars)`,
        '',
        post.text,
      ];
      if (post.images.length) lines.push('', `**Images:** ${post.images.map(i => i.url).join(', ')}`);
      const tagged = post.images.flatMap(i => i.userTags ?? []).map(t => `@${t.handle}`);
      if (tagged.length) lines.push('', `**Tagged:** ${tagged.join(', ')}`);
      if (post.firstComment) lines.push('', `**First comment:**`, '', post.firstComment);
      return lines.join('\n');
    });
    return `## ${group.title}\n\n${posts.join('\n\n')}`;
  });

  return `${header}\n\n---\n\n${sections.join('\n\n---\n\n')}\n\n---\n\n*Edit these drafts, then run with --schedule to push to Buffer.*\n`;
}

// --- Main ---

// Mon-Sun. Saturday becomes a question one week in three (isQuestionWeek).
const WEEK_PLAN: DayKind[] = ['indie', 'indie', 'indie', 'record-math', 'indie', 'indie', 'maker'];

async function main() {
  const args = process.argv.slice(2);
  const weekArg = args.includes('--week') ? args[args.indexOf('--week') + 1] : undefined;
  const doSchedule = args.includes('--schedule');
  const doPublish = args.includes('--publish');
  const doChannels = args.includes('--channels');

  if (doChannels) {
    await listChannels();
    return;
  }

  // Checked before anything is generated: history is saved before scheduling, and the workflow
  // commits it even after a failed run, so a missing secret found later would record artists as
  // featured whose posts were never sent.
  const token = process.env.BUFFER_ACCESS_TOKEN;
  const channelIdsStr = process.env.BUFFER_CHANNEL_IDS;
  const orgId = process.env.BUFFER_ORG_ID;
  if (doSchedule) {
    if (!token) {
      console.error('\n✗ BUFFER_ACCESS_TOKEN not set. Cannot schedule.');
      process.exit(1);
    }
    if (!orgId) {
      console.error('\n✗ BUFFER_ORG_ID not set. Content items belong to an organization, so scheduling needs it.');
      process.exit(1);
    }
    if (!channelIdsStr) {
      console.error('\n✗ BUFFER_CHANNEL_IDS not set. Run with --channels to find your IDs.');
      console.error('  Set as: BUFFER_CHANNEL_IDS=threads_id,bluesky_id,instagram_id,linkedin_id');
      process.exit(1);
    }
  }
  const tagIds = doSchedule && orgId ? await ensureTags(orgId) : null;

  const { week, dates } = getWeekDates(weekArg);
  console.log(`\nGenerating posts for week ${week} (${dates[0]} → ${dates[6]})\n`);

  // Load data
  const history = loadHistory();
  const manifest = loadManifest();
  const artistList = loadArtistList();
  const verifiedArtists = await fetchVerifiedArtists();
  const canonicalSlugsMap = await fetchCanonicalSlugs();

  console.log(`  ${verifiedArtists.length} verified indie artists`);
  console.log(`  ${manifest.length} prominent artists in manifest`);

  if (verifiedArtists.length === 0) {
    console.warn('⚠ No verified artists found. Indie days will be skipped.');
  }

  // Filter out non-music artists (comedians, actors, etc.) and artists who have died, via Wikidata
  console.log('  Checking Wikidata for non-music and deceased artists...');
  const excluded = await findExcludedArtists(artistList);
  if (excluded.slugs.size > 0) {
    console.log(`  Excluding ${excluded.slugs.size} non-music or deceased artists`);
  }

  // Merge Wikidata exclusions with hardcoded safety net
  for (const slug of MANUAL_EXCLUDE_SLUGS) excluded.slugs.add(slug);

  // Filter manifest to only music artists with good data.
  //
  // An incomplete Wikidata lookup empties the exclusion set, which is indistinguishable from
  // "nothing to exclude" — and the thing being excluded is posts telling people to go support a
  // dead artist. So an incomplete lookup drops this pool entirely for the run: the verified indie
  // artists below need no Wikidata check and can carry the week on their own.
  const prominentPool = !excluded.complete
    ? []
    : manifest
        // Acts removed on ethical grounds (api/lib/excluded-artists.ts) still have a manifest
        // entry and a data file — nothing removes either — so without this check the weekly
        // post run would feature them again. Static, unlike the Wikidata set: it applies even
        // when that lookup failed and dropped the pool entirely.
        .filter(a => !isExcludedArtistSlug(a.slug))
        .filter(a => {
          if (excluded.slugs.has(a.slug)) return false;
          const data = loadArtistData(a.slug);
          if (!data) return false;
          const platform = sellingPlatform(data.platforms, a.name, []);
          if (!platform) return false;
          // These links were matched by name, and some are another act's page entirely
          // ("venomnoise" for Venom); bandcampMatchesArtist says why a strict match is the price.
          if (platform.id !== 'bandcamp') return true;
          const link = data.platforms.find(p => p.sourceId === 'bandcamp' && !isSearchUrl(p.url));
          return !!link && bandcampMatchesArtist(a.name, link.url);
        })
        // Retired slugs (accent re-slugs, merges) post at their canonical URL. The manifest slug
        // is kept alongside: the generated data files are keyed by it, so platform lookup still
        // goes through the manifest slug. Two manifest slugs can share a canonical (a merge alias
        // and a re-slug) — keep the first so one artist isn't featured twice.
        .map(a => ({ ...a, manifestSlug: a.slug, slug: canonicalSlugsMap.get(a.slug) ?? a.slug }))
        .filter((a, i, pool) => pool.findIndex(b => b.slug === a.slug) === i);

  if (!excluded.complete) {
    console.warn(
      '  ⚠ Wikidata lookup was incomplete — skipping the prominent-artist pool for this run ' +
        'rather than risk featuring a deceased or non-music artist.'
    );
  }
  console.log(`  ${prominentPool.length} prominent artists with a platform that sells their music (and, on Bandcamp, a page that's theirs)\n`);

  const weekDir = join(SOCIAL_DIR, week);
  if (!existsSync(weekDir)) mkdirSync(weekDir, { recursive: true });

  const drafts: DayDraft[] = [];
  const weekNum = parseInt(week.split('-W')[1], 10);
  const run: RunPicks = { featured: new Set(), skipped: new Set() };
  // The indie artists posted so far this week, for Thursday's LinkedIn roundup.
  const weekIndie: ArtistContext[] = [];
  // Instagram posts dropped because none of their cards rendered. Counted as failures when
  // scheduling: the renderer is broken, and that shouldn't pass as a quiet week.
  let instagramDropped = 0;

  for (let day = 1; day <= 7; day++) {
    const date = dates[day - 1];
    let kind = WEEK_PLAN[day - 1];
    if (day === 6 && isQuestionWeek(weekNum)) kind = 'question';

    // The day's posts share a subject, so they go to Buffer as one group.
    const posts: SocialPost[] = [];
    let artistName: string | null = null;
    let artistSlug: string | null = null;
    let subject: string | null = null;

    if (kind === 'indie') {
      const bandcampFriday = BANDCAMP_FRIDAY_DATES.includes(date);
      const picked = await pickSpotlight(verifiedArtists, history, run, async artist => {
        const lookup = await fetchIndieArtist(artist.slug);
        if (!lookup) {
          console.warn(`  ⚠ ${artist.name}: artist lookup failed — trying someone else`);
          return null;
        }
        const context = artistContext(artist, `${UNSTREAM_BASE}/a/${artist.slug}`, lookup.platforms, lookup.location, lookup.releases);
        const spotlight = indieSpotlight(context, { bandcampFriday });
        if (!spotlight) {
          console.log(`  · ${artist.name}: nowhere to buy their music yet — trying someone else`);
          return null;
        }
        return { context, posts: spotlight };
      });
      if (picked) {
        for (const post of picked.posts) {
          if (post.platform !== 'instagram') {
            posts.push(post);
            continue;
          }
          const instagram = await withRenderableCards(post, picked.artist.name);
          if (instagram) {
            posts.push(instagram);
          } else {
            instagramDropped++;
            console.warn(`  ⚠ ${picked.artist.name}: none of the Instagram cards rendered — no Instagram post`);
          }
        }
        weekIndie.push(picked.context);
        artistName = picked.artist.name;
        artistSlug = picked.artist.slug;
      }
    } else if (kind === 'record-math') {
      const bandcampFridayTomorrow = BANDCAMP_FRIDAY_DATES.includes(dates[day] ?? '');
      const picked = await pickSpotlight(prominentPool, history, run, async artist => {
        // Data files are keyed by the manifest slug; the post URL uses the (possibly
        // re-pointed) canonical one.
        const data = loadArtistData(artist.manifestSlug);
        if (!data) return null;
        const context = artistContext(artist, `${UNSTREAM_BASE}/artist/${artist.slug}`, data.platforms, null, []);
        const math = recordMath(context, { bandcampFridayTomorrow });
        return math ? { context, posts: math } : null;
      });
      if (picked) {
        posts.push(...picked.posts);
        artistName = picked.artist.name;
        artistSlug = picked.artist.slug;
      }
    } else if (kind === 'question') {
      posts.push(...questionPost(weekNum));
    } else {
      // Sunday: an unannounced shipped feature if there is one, otherwise the maker rotation.
      const feature = loadShippedFeatures().find(f => !f.announced);
      if (feature) {
        kind = 'feature';
        subject = feature.title;
        posts.push(...featurePost(feature));
        markFeatureAnnounced(feature.id);
      } else {
        posts.push(...makerPost(weekNum));
      }
    }

    const groups: PostGroup[] = [];
    if (posts.length > 0) {
      const about = artistName ?? subject;
      groups.push({ title: `${KIND_LABELS[kind]}${about ? `: ${about}` : ''}`, tag: TAG_FOR_KIND[kind], posts });
    } else {
      console.log(`  Day ${day} (${date}): no ${KIND_LABELS[kind].toLowerCase()} available`);
    }

    // The LinkedIn page: Tuesday's weekday post, Thursday's roundup of Monday to Wednesday. Each
    // is its own subject, so its own group.
    if (day === 2) {
      groups.push({
        title: 'LinkedIn weekday post',
        tag: 'mission',
        posts: [linkedinWeekdayPost(weekNum, { bandcampFridayThisWeek: BANDCAMP_FRIDAY_DATES.includes(dates[4]) })],
      });
    }
    if (day === 4) {
      const roundup = linkedinRoundup(weekIndie);
      if (roundup) groups.push({ title: 'LinkedIn roundup', tag: 'roundup', posts: [roundup] });
      else console.log(`  · Thursday: fewer than two indie artists this week — no LinkedIn roundup`);
    }

    if (groups.length === 0) continue;

    const draft: DayDraft = { day, date, kind, artistName, artistSlug, groups };
    drafts.push(draft);
    console.log(`  ${DAY_NAMES[day - 1]} ${date}: ${groups.map(g => g.title).join(' + ')}`);
    for (const post of groups.flatMap(g => g.posts)) {
      const problem = lengthProblem(post);
      if (problem) console.warn(`    ⚠ ${PLATFORM_LABELS[post.platform]} post is too long (${problem}) — needs a manual trim`);
    }

    writeFileSync(join(weekDir, `day-${day}.md`), draftToMarkdown(draft));
  }

  // Write full week JSON
  writeFileSync(join(weekDir, 'drafts.json'), JSON.stringify(drafts, null, 2));
  saveHistory(history);

  console.log(`\n✓ Drafts written to ${weekDir}/`);
  console.log(`  - ${drafts.length} day files (day-N.md)`);
  console.log(`  - drafts.json (machine-readable)`);

  // --- Schedule to Buffer ---
  if (doSchedule && channelIdsStr && orgId && tagIds) {
    const [threadsId, blueskyId, instagramId, linkedinId] = channelIdsStr.split(',').map(id => id.trim());
    const channels: Record<Platform, string | undefined> = { threads: threadsId, bluesky: blueskyId, instagram: instagramId, linkedin: linkedinId };
    const saveToDraft = !doPublish;

    if (doPublish && instagramId && dates[0] < INSTAGRAM_DRAFTS_BEFORE) {
      console.log(`\nInstagram posts before ${INSTAGRAM_DRAFTS_BEFORE} go to Buffer as drafts, to be reviewed there first.`);
    }
    if (saveToDraft) {
      console.log('\nPushing to Buffer as DRAFTS (review in Buffer dashboard before publishing)...\n');
    } else {
      console.log('\nScheduling to Buffer for PUBLICATION...\n');
    }

    const labelForChannel = new Map<string, string>();
    for (const platform of Object.keys(channels) as Platform[]) {
      const channelId = channels[platform];
      if (channelId) labelForChannel.set(channelId, PLATFORM_LABELS[platform]);
    }

    let failures = instagramId ? instagramDropped : 0;
    for (const draft of drafts) {
      for (const group of draft.groups) {
        console.log(`  ${draft.date} — ${group.title}`);

        const inputs: Record<string, unknown>[] = [];
        let instagramInput: Record<string, unknown> | null = null;
        for (const post of group.posts) {
          const channelId = channels[post.platform];
          if (!channelId) continue;
          const problem = lengthProblem(post);
          if (problem) {
            failures++;
            console.error(`    ✗ ${PLATFORM_LABELS[post.platform]}: too long to send (${problem})`);
            continue;
          }
          const draftOnly = saveToDraft || (post.platform === 'instagram' && draft.date < INSTAGRAM_DRAFTS_BEFORE);
          const input = postInput(post, channelId, draft.date, draftOnly, tagIds[group.tag]);
          if (post.platform === 'instagram') instagramInput = input;
          else inputs.push(input);
        }

        // Instagram is created on its own and then added to the day's content item. Inside the
        // item, a variant Buffer rejected would take Threads and Bluesky down with it (validation
        // is all-or-nothing), and the failure payload doesn't say whether the other posts were
        // created, so they couldn't safely be sent again. Alone, a rejected Instagram post costs
        // only itself.
        const results: BufferResult[] = [];
        if (inputs.length > 1) {
          results.push(await createBufferContentItem(orgId, group.title, `${draft.date}T${POST_TIME_UTC.threads}:00Z`, tagIds[group.tag], inputs));
        } else if (inputs.length === 1) {
          results.push(await createBufferPost(inputs[0]));
        }
        const contentItemId = results[0]?.contentItemId;
        if (instagramInput) {
          const instagram = await createBufferPost(instagramInput);
          results.push(instagram);
          const postId = instagram.created[0]?.id;
          const groupError = contentItemId && postId ? await addPostToContentItem(contentItemId, postId) : null;
          if (groupError) console.warn(`    ⚠ Instagram post ${postId} is scheduled but not grouped with the others: ${groupError}`);
        }

        for (const result of results) {
          for (const post of result.created) {
            console.log(`    ✓ ${post.status} — ${labelForChannel.get(post.channelId) ?? post.channelId} (${post.id})`);
          }
          for (const error of result.errors) {
            failures++;
            const label = error.channelId ? `${labelForChannel.get(error.channelId) ?? error.channelId}: ` : '';
            console.error(`    ✗ ${label}${error.message}`);
          }
        }
      }
    }

    if (failures > 0) {
      console.error(`\n✗ ${failures} post(s) were not sent. Everything else is scheduled and history is saved.\n`);
      process.exitCode = 1;
    } else if (saveToDraft) {
      console.log('\n✓ Drafts pushed to Buffer. Review and approve them in the Buffer dashboard.');
      console.log('  To schedule directly instead: add --publish flag.\n');
    } else {
      console.log('\n✓ Posts scheduled for publication.\n');
    }
  } else {
    console.log('\nReview the drafts, then push to Buffer as drafts:');
    console.log(`  npx tsx scripts/generate-social-posts.ts --week ${week} --schedule\n`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
