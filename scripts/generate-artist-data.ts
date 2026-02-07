/**
 * Generate pre-built search result data for each artist in the artist list.
 * Fetches from the deployed production API, merges with MusicBrainz data,
 * and saves per-artist JSON files + a manifest index.
 *
 * Output:
 *   data/artists/{slug}.json      - Full SearchResult[] for each artist
 *   data/artists-manifest.json    - Index with metadata for all artists
 *
 * Usage: npx tsx scripts/generate-artist-data.ts [--limit N] [--force]
 *
 * Options:
 *   --limit N   Only process the first N artists (for testing)
 *   --force     Re-fetch even if recent data exists
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const ARTISTS_DIR = join(DATA_DIR, 'artists');
const ARTIST_LIST_PATH = join(DATA_DIR, 'artist-list.json');
const MANIFEST_PATH = join(DATA_DIR, 'artists-manifest.json');

const API_BASE = 'https://unstream.stream';
const CONCURRENCY = 3;
const MB_DELAY_MS = 1100; // MusicBrainz rate limit: 1 req/sec
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days - skip if data is newer

interface ArtistEntry {
  name: string;
  slug: string;
  musicbrainzId: string;
}

interface PlatformLink {
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
    const socialPlatforms = new Set(['instagram', 'facebook', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon']);
    newPlatforms.sort((a, b) => {
      const aIsSocial = socialPlatforms.has(a.sourceId);
      const bIsSocial = socialPlatforms.has(b.sourceId);
      if (aIsSocial && !bIsSocial) return 1;
      if (!aIsSocial && bIsSocial) return -1;
      if (aIsSocial && bIsSocial) {
        const order = ['instagram', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon', 'facebook'];
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

async function fetchSearchResults(artistName: string): Promise<SearchResponse> {
  const url = `${API_BASE}/api/search/sources?query=${encodeURIComponent(artistName)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Unstream-DataGen/1.0' },
  });
  if (!response.ok) {
    throw new Error(`Search API error for "${artistName}": ${response.status}`);
  }
  return response.json();
}

async function fetchMusicBrainzData(artistName: string): Promise<MusicBrainzData | null> {
  const url = `${API_BASE}/api/search/musicbrainz?query=${encodeURIComponent(artistName)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Unstream-DataGen/1.0' },
  });
  if (!response.ok) return null;
  return response.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processArtist(artist: ArtistEntry, force: boolean): Promise<ManifestEntry | null> {
  const outputPath = join(ARTISTS_DIR, `${artist.slug}.json`);

  // Skip if recent data exists and not forcing
  if (!force && existsSync(outputPath)) {
    const stat = statSync(outputPath);
    const age = Date.now() - stat.mtimeMs;
    if (age < MAX_AGE_MS) {
      // Read existing data for manifest
      try {
        const existing: SearchResult[] = JSON.parse(readFileSync(outputPath, 'utf-8'));
        const firstArtist = existing.find(r => r.type === 'artist');
        return {
          name: artist.name,
          slug: artist.slug,
          imageUrl: firstArtist?.imageUrl || null,
          platformCount: firstArtist?.platforms.length || 0,
          lastUpdated: stat.mtime.toISOString(),
        };
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

    // Save results
    writeFileSync(outputPath, JSON.stringify(results, null, 2));

    const firstArtist = results.find(r => r.type === 'artist');
    const now = new Date().toISOString();

    return {
      name: artist.name,
      slug: artist.slug,
      imageUrl: firstArtist?.imageUrl || null,
      platformCount: firstArtist?.platforms.length || 0,
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

    // Brief pause between batches to avoid overwhelming the API
    if (i + concurrency < artists.length) {
      await sleep(500);
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

  console.log(`Processing ${artists.length} artists (${force ? 'force refresh' : 'skipping recent'})...`);

  mkdirSync(ARTISTS_DIR, { recursive: true });

  const manifest = await processInBatches(artists, force, CONCURRENCY);

  // Write manifest
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nWrote manifest with ${manifest.length} entries to ${MANIFEST_PATH}`);
  console.log('Done!');
}

main();
