/**
 * Generate pre-built search result data for each artist in the artist list.
 * Fetches from the deployed production API, merges with MusicBrainz data,
 * and saves per-artist JSON files + a manifest index.
 *
 * Quality filtering:
 *   - Only saves artists with a verified presence on Bandcamp, Faircamp,
 *     Mirlo, or Patreon (non-search-only direct links).
 *   - Only saves if exactly ONE artist-type result matches the searched name,
 *     ensuring the page represents the right artist without ambiguity.
 *
 * Output:
 *   data/artists/{slug}.json      - Single matching SearchResult (as array) for each artist
 *   data/artists-manifest.json    - Index with metadata for all qualifying artists
 *
 * Usage: npx tsx scripts/generate-artist-data.ts [--limit N] [--force] [--local] [--skip-validation]
 *
 * Options:
 *   --limit N           Only process the first N artists (for testing)
 *   --force             Re-fetch even if recent data exists
 *   --local             Use local dev server (localhost:5173) instead of production API
 *                       Bypasses production rate limiting. Run `npm run dev` first.
 *   --skip-validation   Skip MusicBrainz release cross-reference validation
 *                       (faster runs, but won't catch name collisions)
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isExcludedArtistSlug } from '../api/lib/excluded-artists';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const ARTISTS_DIR = join(DATA_DIR, 'artists');
const ARTIST_LIST_PATH = join(DATA_DIR, 'artist-list.json');
const MANIFEST_PATH = join(DATA_DIR, 'artists-manifest.json');

const LOCAL_API = 'http://localhost:5173';
const PROD_API = 'https://unstream.stream';
const useLocal = process.argv.includes('--local');
const API_BASE = useLocal ? LOCAL_API : PROD_API;
const CONCURRENCY = useLocal ? 3 : 1; // Sequential against production to respect rate limits
const MB_DELAY_MS = 1100; // MusicBrainz rate limit: 1 req/sec
const API_DELAY_MS = useLocal ? 500 : 2500; // Delay between batches: generous for production (30 req/min)
const MAX_RETRIES = 3;
const skipValidation = process.argv.includes('--skip-validation');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days - skip if data is newer

// Artist must have a verified (non-search-only) link on at least one of these
const QUALIFYING_PLATFORMS = new Set(['bandcamp', 'faircamp', 'mirlo']);

// Known false matches: famous artist name matches a different person on Bandcamp.
// These are excluded from data generation entirely.
const BLOCKLIST_SLUGS = new Set([
  'a-ha',              // "sashabeats" on Bandcamp, not the Norwegian band
  'abc',               // "alphabetset", not Martin Fry's band
  'alice',             // ambiguous name, not a notable artist
  'andrew-fletcher',   // not the Depeche Mode member
  'band-aid',          // demo band, not the charity supergroup
  'bwo',               // "godisalobster", not Bodies Without Organs
  'h-e-r',             // record label, not H.E.R. the singer
  'highway',           // producer, not a notable band
  'ian-brown',         // "ammogideon", not the Stone Roses singer
  'jj',                // "jackjutson", not the Swedish duo
  'jasmine-thompson',  // different person
  'kyuss',             // "enviaudio", not the stoner rock band
  'mark-isham',        // generic Bandcamp, not the film composer
  'michael-mcdonald',  // different Michael McDonald
  'saxon',             // "sxn93", not the NWOBHM band
  'sleeping-with-sirens', // "payforyersins", not the post-hardcore band
  'steve-clark',       // not the Def Leppard guitarist
  'the-crystals',      // "thecrystalawards", not the 60s girl group
  'toto',              // DJ posting remixes, not Toto
  'alexey-vorobyov',   // "34birds", different person
  'bo-diddley',        // legacy artist, not active
  'lee-majors',        // actor, not a music artist
]);

interface ArtistEntry {
  name: string;
  slug: string;
  musicbrainzId: string;
}

interface PlatformLink {
  sourceId: string;
  url: string;
  allReleaseTitles?: string[];
  latestRelease?: {
    title: string;
    type: string;
    url: string;
    imageUrl?: string;
    releaseDate?: string;
  };
}

interface SearchResult {
  id: string;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  imageUrl?: string;
  platforms: PlatformLink[];
  matchConfidence?: 'verified' | 'unverified';
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
  hasPendingEnrichment?: boolean;
}

interface SocialLink {
  platform: string;
  url: string;
}

interface MusicBrainzData {
  query: string;
  artistName: string | null;
  officialUrl: string | null;
  discogsUrl: string | null;
  hasPre2005Release: boolean;
  socialLinks: SocialLink[];
}

interface ManifestEntry {
  name: string;
  slug: string;
  imageUrl: string | null;
  platformCount: number;
  lastUpdated: string;
}

function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mergeWithMusicBrainzData(results: SearchResult[], mbData: MusicBrainzData): SearchResult[] {
  if (!mbData.artistName) return results;

  const mbNormalized = normalizeForComparison(mbData.artistName);

  return results.map(result => {
    if (result.type !== 'artist') return result;

    const resultNormalized = normalizeForComparison(result.name);
    const isMatch =
      resultNormalized === mbNormalized ||
      resultNormalized.includes(mbNormalized) ||
      mbNormalized.includes(resultNormalized);

    if (!isMatch) return result;

    const newPlatforms = [...result.platforms];

    if (mbData.officialUrl && !newPlatforms.some(p => p.sourceId === 'officialsite')) {
      newPlatforms.push({ sourceId: 'officialsite', url: mbData.officialUrl });
    }
    if (mbData.discogsUrl && !newPlatforms.some(p => p.sourceId === 'discogs')) {
      newPlatforms.push({ sourceId: 'discogs', url: mbData.discogsUrl });
    }
    if (mbData.hasPre2005Release) {
      if (!newPlatforms.some(p => p.sourceId === 'hoopla')) {
        newPlatforms.push({
          sourceId: 'hoopla',
          url: `https://www.hoopladigital.com/search?q=${encodeURIComponent(result.name)}&type=music`,
        });
      }
      if (!newPlatforms.some(p => p.sourceId === 'freegal')) {
        newPlatforms.push({
          sourceId: 'freegal',
          url: `https://www.freegalmusic.com/search-page/${encodeURIComponent(result.name)}`,
        });
      }
    }

    if (mbData.socialLinks && mbData.socialLinks.length > 0) {
      for (const social of mbData.socialLinks) {
        const existingIndex = newPlatforms.findIndex(p => p.sourceId === social.platform);
        if (existingIndex === -1) {
          newPlatforms.push({ sourceId: social.platform, url: social.url });
        } else {
          const existingUrl = newPlatforms[existingIndex].url.toLowerCase();
          const isSearchUrl = existingUrl.includes('duckduckgo.com') ||
            existingUrl.includes('/search') ||
            existingUrl.includes('?q=') ||
            existingUrl.includes('?query=') ||
            existingUrl.includes('/explore');
          if (isSearchUrl) {
            newPlatforms[existingIndex] = { sourceId: social.platform, url: social.url };
          }
        }
      }
    }

    // Sort platforms
    const searchOnlyPlatforms = new Set(['ampwall', 'kofi', 'buymeacoffee']);
    const officialPlatforms = new Set(['officialsite', 'discogs', 'hoopla', 'freegal']);
    const socialPlatforms = new Set(['instagram', 'facebook', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon', 'peertube']);
    newPlatforms.sort((a, b) => {
      const aIsSocial = socialPlatforms.has(a.sourceId);
      const bIsSocial = socialPlatforms.has(b.sourceId);
      if (aIsSocial && !bIsSocial) return 1;
      if (!aIsSocial && bIsSocial) return -1;
      if (aIsSocial && bIsSocial) {
        const order = ['instagram', 'tiktok', 'youtube', 'peertube', 'threads', 'bluesky', 'mastodon', 'facebook'];
        return order.indexOf(a.sourceId) - order.indexOf(b.sourceId);
      }
      const aIsOfficial = officialPlatforms.has(a.sourceId);
      const bIsOfficial = officialPlatforms.has(b.sourceId);
      if (aIsOfficial && bIsOfficial) {
        const order = ['officialsite', 'discogs', 'hoopla', 'freegal'];
        return order.indexOf(a.sourceId) - order.indexOf(b.sourceId);
      }
      if (aIsOfficial) return 1;
      if (bIsOfficial) return -1;
      const aIsSearchOnly = searchOnlyPlatforms.has(a.sourceId);
      const bIsSearchOnly = searchOnlyPlatforms.has(b.sourceId);
      if (aIsSearchOnly && !bIsSearchOnly) return 1;
      if (!aIsSearchOnly && bIsSearchOnly) return -1;
      return 0;
    });

    return { ...result, platforms: newPlatforms };
  });
}

async function fetchWithRetry(url: string, label: string): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Unstream-DataGen/1.0' },
    });

    if (response.ok) return response;

    if (response.status === 429) {
      // Parse Retry-After header, default to exponential backoff
      const retryAfter = response.headers.get('Retry-After');
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : attempt * 15;
      const waitMs = Math.max(waitSec, 5) * 1000;
      if (attempt < MAX_RETRIES) {
        console.warn(`  ⚠ Rate limited on "${label}" (attempt ${attempt}/${MAX_RETRIES}), waiting ${Math.round(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }
    }

    if (attempt === MAX_RETRIES) {
      throw new Error(`${label}: ${response.status} after ${MAX_RETRIES} attempts`);
    }
  }

  throw new Error(`${label}: exhausted retries`);
}

async function fetchSearchResults(artistName: string): Promise<SearchResponse> {
  const url = `${API_BASE}/api/search/sources?query=${encodeURIComponent(artistName)}`;
  const response = await fetchWithRetry(url, `Search "${artistName}"`);
  return response.json();
}

async function fetchMusicBrainzData(artistName: string): Promise<MusicBrainzData | null> {
  const url = `${API_BASE}/api/search/musicbrainz?query=${encodeURIComponent(artistName)}`;
  try {
    const response = await fetchWithRetry(url, `MusicBrainz "${artistName}"`);
    return response.json();
  } catch {
    return null; // MusicBrainz enrichment is optional — don't fail the whole artist
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if a result has a verified (non-search-only) link on a qualifying platform.
 * Search-only URLs (duckduckgo, /search, ?q=, etc.) don't count.
 * For Bandcamp, fan profiles (bandcamp.com/username) don't count —
 * only artist pages ([artist].bandcamp.com) qualify.
 */
function hasQualifyingPlatform(result: SearchResult): boolean {
  return result.platforms.some(p => {
    if (!QUALIFYING_PLATFORMS.has(p.sourceId)) return false;
    // Exclude search-only URLs — these aren't verified artist presences
    const url = p.url.toLowerCase();
    const isSearchUrl = url.includes('duckduckgo.com') ||
      url.includes('/search') ||
      url.includes('?q=') ||
      url.includes('?query=') ||
      url.includes('/explore');
    if (isSearchUrl) return false;

    // For Bandcamp, only count artist pages (subdomain), not fan profiles (path),
    // and require at least one release (filters out squatter/empty pages)
    if (p.sourceId === 'bandcamp') {
      try {
        const parsed = new URL(url);
        if (parsed.hostname === 'bandcamp.com' || parsed.hostname === 'www.bandcamp.com') {
          return false; // Fan profile, not an artist page
        }
      } catch {
        return false;
      }
      // Must have at least one release — empty Bandcamp pages don't count
      const hasReleases = (p.allReleaseTitles && p.allReleaseTitles.length > 0) || p.latestRelease;
      if (!hasReleases) return false;
    }

    return true;
  });
}

/**
 * Check if a result's name matches the artist we're looking for.
 * Uses exact normalized match only — no substring matching,
 * to avoid "Chevy Chase" matching "Chevy Chase Stole My Wife".
 */
function isNameMatch(resultName: string, artistName: string): boolean {
  return normalizeForComparison(resultName) === normalizeForComparison(artistName);
}

/**
 * Normalize a release title for comparison: lowercase, strip non-alphanumeric.
 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Validate that a Bandcamp artist is the same person as the MusicBrainz artist
 * by comparing release titles. Returns true if there's any overlap (or if
 * validation can't be performed).
 */
async function validateArtistMatch(
  artist: ArtistEntry,
  bandcampTitles: string[]
): Promise<{ valid: boolean; reason?: string }> {
  if (skipValidation) return { valid: true };
  if (!artist.musicbrainzId) return { valid: true };
  if (bandcampTitles.length === 0) return { valid: true };

  await sleep(MB_DELAY_MS);

  try {
    const url = `https://musicbrainz.org/ws/2/release-group?artist=${artist.musicbrainzId}&type=album|single|ep&limit=50&fmt=json`;
    const response = await fetchWithRetry(url, `MB validate "${artist.name}"`);
    const data = await response.json();
    const releaseGroups = data['release-groups'] || [];

    // If MB has very few releases, skip validation (too unreliable)
    if (releaseGroups.length <= 2) return { valid: true };

    const mbTitles = new Set(
      releaseGroups.map((rg: { title: string }) => normalizeTitle(rg.title))
    );
    const bcTitles = new Set(
      bandcampTitles.map(normalizeTitle)
    );

    // Remove self-titled entries (common for both real and impostor artists)
    const artistNorm = normalizeTitle(artist.name);
    mbTitles.delete(artistNorm);
    bcTitles.delete(artistNorm);

    // Check for any overlap
    let overlap = 0;
    for (const title of bcTitles) {
      if (mbTitles.has(title)) overlap++;
    }

    if (overlap === 0) {
      return {
        valid: false,
        reason: `no release overlap (MB: ${releaseGroups.length} releases, BC: ${bandcampTitles.length} releases)`,
      };
    }

    return { valid: true };
  } catch {
    // If validation fails (network error, etc.), allow the artist through
    return { valid: true };
  }
}

async function processArtist(artist: ArtistEntry, force: boolean): Promise<ManifestEntry | null> {
  // Skip blocklisted artists (known false matches)
  if (BLOCKLIST_SLUGS.has(artist.slug)) return null;

  // Skip acts removed on ethical grounds (api/lib/excluded-artists.ts). Consumers — the sitemap,
  // the social posts, isPublishedArtistSlug on the artist-page endpoint — all filter this list,
  // but a fresh manifest that includes them would reinstate the published URL everywhere at
  // once. Keeping the exclusion out of the generated manifest is what keeps the list the one
  // place that decision is recorded.
  if (isExcludedArtistSlug(artist.slug)) return null;

  const outputPath = join(ARTISTS_DIR, `${artist.slug}.json`);

  // Skip if recent data exists and not forcing
  if (!force && existsSync(outputPath)) {
    const stat = statSync(outputPath);
    const age = Date.now() - stat.mtimeMs;
    if (age < MAX_AGE_MS) {
      // Read existing data for manifest — also validate qualifying platform
      try {
        const existing: SearchResult[] = JSON.parse(readFileSync(outputPath, 'utf-8'));
        const match = existing.find(r => r.type === 'artist');
        if (match && hasQualifyingPlatform(match)) {
          return {
            name: artist.name,
            slug: artist.slug,
            imageUrl: match.imageUrl || null,
            platformCount: match.platforms.length || 0,
            lastUpdated: stat.mtime.toISOString(),
          };
        }
      } catch {
        // Corrupted file, re-fetch
      }
    }
  }

  try {
    // Fetch search results
    const searchResponse = await fetchSearchResults(artist.name);
    let results = searchResponse.results;

    // Fetch and merge MusicBrainz data
    await sleep(MB_DELAY_MS);
    const mbData = await fetchMusicBrainzData(artist.name);
    if (mbData) {
      results = mergeWithMusicBrainzData(results, mbData);
    }

    // Filter: only artist-type results whose name matches the searched artist
    const matchingArtists = results.filter(r =>
      r.type === 'artist' && isNameMatch(r.name, artist.name)
    );

    // Filter: must have a qualifying platform (Bandcamp/Faircamp/Mirlo/Patreon)
    const qualifyingArtists = matchingArtists.filter(hasQualifyingPlatform);

    // Only save if exactly one qualifying artist — avoids ambiguity
    if (qualifyingArtists.length !== 1) {
      return null;
    }

    const theArtist = qualifyingArtists[0];

    // Validate: compare Bandcamp releases against MusicBrainz discography
    // to detect name collisions (different artist on Bandcamp than expected)
    const bandcamp = theArtist.platforms.find(p => p.sourceId === 'bandcamp');
    const bcTitles = bandcamp?.allReleaseTitles || [];
    const validation = await validateArtistMatch(artist, bcTitles);
    if (!validation.valid) {
      console.warn(`  ⚠ Skipping ${artist.name}: ${validation.reason}`);
      return null;
    }

    // Save only this single artist result (as an array for compatibility)
    writeFileSync(outputPath, JSON.stringify([theArtist], null, 2));

    const now = new Date().toISOString();

    return {
      name: artist.name,
      slug: artist.slug,
      imageUrl: theArtist.imageUrl || null,
      platformCount: theArtist.platforms.length || 0,
      lastUpdated: now,
    };
  } catch (error) {
    console.error(`  Failed to process ${artist.name}:`, error);
    return null;
  }
}

async function processInBatches(
  artists: ArtistEntry[],
  force: boolean,
  concurrency: number
): Promise<ManifestEntry[]> {
  const manifest: ManifestEntry[] = [];
  let completed = 0;

  for (let i = 0; i < artists.length; i += concurrency) {
    const batch = artists.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(artist => processArtist(artist, force))
    );

    for (const entry of results) {
      if (entry) manifest.push(entry);
    }

    completed += batch.length;
    console.log(`  Progress: ${completed}/${artists.length} (${Math.round(completed / artists.length * 100)}%)`);

    // Pause between batches — longer for production to stay under rate limits
    if (i + concurrency < artists.length) {
      await sleep(API_DELAY_MS);
    }
  }

  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;
  const force = args.includes('--force');

  if (!existsSync(ARTIST_LIST_PATH)) {
    console.error('Artist list not found. Run generate-artist-list.ts first.');
    process.exit(1);
  }

  const artistList: ArtistEntry[] = JSON.parse(readFileSync(ARTIST_LIST_PATH, 'utf-8'));
  const artists = limit ? artistList.slice(0, limit) : artistList;

  console.log(`API: ${API_BASE}${useLocal ? ' (local — fast, no rate limits)' : ` (production — throttled: ${CONCURRENCY} concurrent, ${API_DELAY_MS}ms delay, retry on 429)`}`);
  console.log(`Processing ${artists.length} artists (${force ? 'force refresh' : 'skipping recent'})...`);

  mkdirSync(ARTISTS_DIR, { recursive: true });

  const manifest = await processInBatches(artists, force, CONCURRENCY);

  const skipped = artists.length - manifest.length;

  // Write manifest
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nResults:`);
  console.log(`  Processed: ${artists.length}`);
  console.log(`  Qualified: ${manifest.length} (have Bandcamp/Faircamp/Mirlo/Patreon + unique match)`);
  console.log(`  Skipped:   ${skipped} (no qualifying platform, ambiguous, or failed)`);
  console.log(`\nWrote manifest with ${manifest.length} entries to ${MANIFEST_PATH}`);
  console.log('Done!');
}

main();
