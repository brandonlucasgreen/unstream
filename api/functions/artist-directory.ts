import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { isDirectLink, readAllPages } from './db';
import { cacheGetOrFetch } from './cache';
import { PLATFORMS } from '../shared/platform-registry';

/**
 * Platforms where a fan's money reaches the artist, derived from the registry rather than listed
 * here so a new platform is covered by adding it there. `library` (Hoopla, Freegal), `official`
 * and `social` are excluded: they are places to hear or read about an artist, not to buy from.
 */
const BUYABLE_PLATFORMS = new Set(
  Object.entries(PLATFORMS)
    .filter(([, meta]) => ['marketplace', 'decentralized', 'patronage'].includes(meta.category))
    .map(([id]) => id)
);

interface KnownArtistRow {
  slug: string;
  name: string;
  image_url: string | null;
  died_on?: string | null;
  artist_links: { platform: string; url: string }[] | null;
}

// Tried in order. The second drops `died_on`: migration 20260804130000 adds that column, and a push
// to main deploys the Netlify functions and runs supabase-migrate concurrently — they are not
// ordered, so there is a window where this function is live and the column is not. Falling back
// leaves the index briefly unfiltered rather than 500ing. Delete the second entry once the column
// has shipped.
const KNOWN_SELECTS = [
  'slug, name, image_url, died_on, artist_links(platform, url)',
  'slug, name, image_url, artist_links(platform, url)',
];

/** Every verified artist with its links, or null if even the fallback select failed. */
async function readVerifiedArtists(supabase: SupabaseClient): Promise<KnownArtistRow[] | null> {
  for (const columns of KNOWN_SELECTS) {
    const result = await readAllPages<KnownArtistRow>(
      (from, to) =>
        supabase
          .from('artists')
          .select(columns)
          .eq('match_confidence', 'verified')
          .range(from, to),
      'verified artists'
    );
    if (result.ok) return result.rows;
  }
  return null;
}

/**
 * `.in()` on a list of primary keys, chunked.
 *
 * Two hazards in one call: PostgREST caps any response at 1,000 rows, and the id list travels in
 * the query string, so a few thousand ids is a 414 rather than a slow query. 200 keeps both away —
 * `id` is unique, so a 200-id chunk can match at most 200 rows and can never reach the row cap,
 * which is why the chunks below don't need paging on top of this.
 */
const ID_CHUNK = 200;

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300, s-maxage=300',
};

export async function handler(event: { queryStringParameters?: Record<string, string> }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // scope=known lists unclaimed-but-verified artists — the pre-generated
  // /artist/ pages backfilled from data/artists-manifest.json (#384/#385).
  // match_confidence is a single, mutually-exclusive column, so this needs
  // no join against artist_profiles the way the claimed path below does.
  //
  // Paged, not a bare .select(): 958 verified artists as of 2026-08-04, and at 1,000 PostgREST
  // starts dropping the rest silently — no error, just a shorter index than the real one.
  //
  // Two groups are then filtered out rather than deleted, because the /artist/ pages behind them
  // are accurate and worth keeping — it is only this index that would misrepresent them. The page
  // promises "artists you know have music available for direct purchase", so it must list only
  // artists that claim is true of:
  //
  //   * artists with no buyable link — 3 had nothing but Instagram and a search placeholder, so
  //     the index was overclaiming outright;
  //   * artists who have died — 107 of them, whose estates do still sell the music, but who the
  //     surrounding copy addresses as though they were here to be supported.
  if (event.queryStringParameters?.scope === 'known') {
    // Redis-cached: this is the single largest-volume read in the codebase — every verified
    // artist WITH their links embedded, ~3 paged requests of 1,000 rows each — behind only a
    // 5-minute CDN window on a crawlable page. The index changes when an artist gains a
    // buyable link or a page is verified, both of which tolerate an hour of lag. A failed
    // read is never cached (the null check below 500s instead, and 5xx isn't CDN-cached
    // either — same reasoning as the claimed path).
    const { data: artists } = await cacheGetOrFetch(
      'artist-directory:known',
      async () => {
        const rows = await readVerifiedArtists(supabase);
        if (!rows) return null;
        return rows
          .filter(a => !a.died_on)
          .filter(a =>
            (a.artist_links || []).some(l => BUYABLE_PLATFORMS.has(l.platform) && isDirectLink(l.url))
          )
          .map(a => ({ slug: a.slug, name: a.name, imageUrl: a.image_url || null }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      3600,
      result => result !== null
    );

    if (!artists) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch artists' }) };
    }

    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ artists }) };
  }

  // Fetch all verified (claimed) artist profiles — 128 today, so the paging is headroom rather
  // than a live fix, but the failure mode is identical and invisible.
  const profiles = await readAllPages<{ artist_id: string; custom_image_url: string | null }>(
    (from, to) =>
      supabase
        .from('artist_profiles')
        .select('artist_id, custom_image_url')
        .not('verified_at', 'is', null)
        .range(from, to),
    'verified artist profiles'
  );

  // A read failure is not "there are no claimed artists". This used to answer 200 with an empty
  // list, which the Cache-Control above then pinned for five minutes — a blank directory served
  // long after the transient error cleared. 5xx isn't cached, and ArtistIndexPage retries it.
  if (!profiles.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch artists' }) };
  }

  if (profiles.rows.length === 0) {
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ artists: [] }) };
  }

  // Fetch artist details
  const artistIds = profiles.rows.map(p => p.artist_id);
  const artistRows: { id: string; name: string; slug: string; image_url: string | null }[] = [];

  for (let i = 0; i < artistIds.length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .from('artists')
      .select('id, name, slug, image_url')
      .in('id', artistIds.slice(i, i + ID_CHUNK));

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch artists' }) };
    }
    artistRows.push(...(data || []));
  }

  const customImageMap = new Map(
    profiles.rows.filter(p => p.custom_image_url).map(p => [p.artist_id, p.custom_image_url])
  );

  const artists = artistRows
    .map(a => ({
      slug: a.slug,
      name: a.name,
      imageUrl: customImageMap.get(a.id) || a.image_url || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ artists }) };
}
