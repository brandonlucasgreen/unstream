/**
 * Measure the real Mirlo↔Bandcamp release overlap rate.
 *
 * Usage:
 *   npx tsx scripts/measure-mirlo-overlap.ts
 *   npx tsx scripts/measure-mirlo-overlap.ts --json
 *   npx tsx scripts/measure-mirlo-overlap.ts --pairs     (print every matched pair)
 *
 * This exists to answer the one question the v1 scope doc has flagged as unmeasured since the
 * start (§9.2): *"Real Mirlo↔Bandcamp overlap rate. Every dedup rule depends on it and I'm
 * guessing."* The tier-1/2/3 thresholds were chosen without it.
 *
 * ## What it compares, and why that way
 *
 * For every artist in Mirlo's Canimus federation catalog who we already have a `mirlo` link
 * for, it compares their Mirlo releases against the releases **already in our own database**
 * for that same artist — not against a fresh Bandcamp crawl.
 *
 * That choice is deliberate on three grounds:
 *
 * 1. **It costs Bandcamp nothing.** Zero outbound requests to Bandcamp; the comparison runs
 *    against rows we already catalogued. The whole run is one request, to Mirlo.
 * 2. **It measures the production path.** The question isn't an abstract "do these catalogues
 *    resemble each other" — it's "when the Mirlo pass runs, how often will it land on a
 *    release row Bandcamp already created?" That is exactly what this computes, using the
 *    same `releaseMatchKey` and `isFuzzyReleaseMatch` the writers use.
 * 3. **The join is artist-asserted, not guessed.** Artists are matched on the Mirlo slug in
 *    their stored link, so no name-similarity heuristic sits between the two catalogues
 *    contaminating the number the heuristics are being measured for.
 *
 * ## Reading the output
 *
 * Every Mirlo release falls into exactly one bucket, named for the dedup tier that would
 * handle it:
 *
 * - `tier2_exact`   — identical `match_key` on an existing row. Auto-merges today.
 * - `tier3_fuzzy`   — `isFuzzyReleaseMatch` hit but not an exact key. Queues for review today.
 * - `distinct`      — no candidate at all. Becomes a new release row.
 *
 * The overlap rate is `(tier2_exact + tier3_fuzzy) / total`. What makes the number actionable
 * is the split: a high `tier3_fuzzy` share means the fuzzy rule is carrying real merges and
 * the admin queue will be busy; a high `tier2_exact` share means exact matching is doing the
 * work and tier 3 is mostly noise.
 *
 * READ-ONLY. No writes, no --write flag. One request to Mirlo per run; don't loop it.
 *
 * ⚠️ Requires MIRLO_CANIMUS_ENABLED=true, the same flag that gates the production pass, so
 * that this cannot make a request to Mirlo before that question is settled.
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const { createClient } = await import('@supabase/supabase-js');
const { safeFetch } = await import('../api/functions/safe-fetch.js');
const { isUrlHostnameAllowed } = await import('../api/functions/middleware.js');
const { ingestCanimusCatalog, buildMirloReleases, mirloArtistSlug } =
  await import('../api/functions/release-ingest.js');
const { isFuzzyReleaseMatch } = await import('../api/functions/release-utils.js');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const showPairs = args.includes('--pairs');

const CATALOG_URL = 'https://mirlo.space/v1/sm/canimus.json';

if (process.env.MIRLO_CANIMUS_ENABLED !== 'true') {
  console.error(
    'Refusing to run: MIRLO_CANIMUS_ENABLED is not "true".\n\n' +
      "Mirlo's robots.txt disallows /v1/, which is where the Canimus federation endpoint lives.\n" +
      'This script makes a real request to that endpoint, so it is gated behind the same flag as\n' +
      'the production pass. Set it only once Mirlo has confirmed the endpoint is ours to call.'
  );
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL and a Supabase key must be set in .env');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// --- 1. The catalog: one request -------------------------------------------------

if (!isUrlHostnameAllowed(CATALOG_URL)) {
  console.error('Canimus URL is not on the outbound allowlist');
  process.exit(1);
}

const response = await safeFetch(CATALOG_URL, 20_000);
if (!response?.ok) {
  console.error(`Canimus fetch failed: ${response ? response.status : 'refused'}`);
  process.exit(1);
}

const catalog = ingestCanimusCatalog(await response.json(), CATALOG_URL);
if (!catalog) {
  console.error('Response was not a Canimus root document — not treating this as an empty catalog.');
  process.exit(1);
}

// --- 2. Our side: stored mirlo links, and each artist's existing releases ---------

const { data: linkRows, error: linkError } = await supabase
  .from('artist_links')
  .select('artist_id, url')
  .eq('platform', 'mirlo');

if (linkError) {
  console.error('Failed to read mirlo artist_links:', linkError.message);
  process.exit(1);
}

/** Mirlo slug -> our artist id. Built with the same slug parser production joins on. */
const artistIdBySlug = new Map<string, string>();
for (const row of (linkRows ?? []) as { artist_id: string; url: string }[]) {
  const slug = mirloArtistSlug(row.url);
  if (slug) artistIdBySlug.set(slug, row.artist_id);
}

const matchedArtists = catalog.artists.filter(a => artistIdBySlug.has(a.slug));

interface Bucket {
  tier2_exact: number;
  tier3_fuzzy: number;
  distinct: number;
}
const totals: Bucket = { tier2_exact: 0, tier3_fuzzy: 0, distinct: 0 };
const pairs: { artist: string; mirlo: string; existing: string; tier: string; platforms: string[] }[] = [];
const artistRows: Record<string, unknown>[] = [];

for (const artist of matchedArtists) {
  const artistId = artistIdBySlug.get(artist.slug)!;

  const { data: existingRows, error: releaseError } = await supabase
    .from('releases')
    .select('id, title, match_key, release_sources(platform)')
    .eq('artist_id', artistId);

  if (releaseError) {
    console.error(`Failed to read releases for ${artist.slug}:`, releaseError.message);
    continue;
  }

  type ExistingRow = { id: string; title: string; match_key: string; release_sources: { platform: string }[] | null };
  const existing = ((existingRows ?? []) as ExistingRow[]).filter(r =>
    // Only rows some *other* platform already contributed. A Mirlo row we wrote on an earlier
    // run of the real pass would otherwise match itself and inflate the overlap to 100%.
    (r.release_sources ?? []).some(s => s.platform !== 'mirlo')
  );
  const byMatchKey = new Map(existing.map(r => [r.match_key, r]));

  const mirloReleases = buildMirloReleases(artist);
  const artistBucket: Bucket = { tier2_exact: 0, tier3_fuzzy: 0, distinct: 0 };

  for (const release of mirloReleases) {
    const exact = byMatchKey.get(release.matchKey);
    const fuzzy = exact ? undefined : existing.find(r => isFuzzyReleaseMatch(r.match_key, release.matchKey));
    const hit = exact ?? fuzzy;
    const tier = exact ? 'tier2_exact' : fuzzy ? 'tier3_fuzzy' : 'distinct';

    artistBucket[tier as keyof Bucket]++;
    totals[tier as keyof Bucket]++;

    if (hit) {
      pairs.push({
        artist: artist.name,
        mirlo: release.title,
        existing: hit.title,
        tier,
        platforms: [...new Set((hit.release_sources ?? []).map(s => s.platform))],
      });
    }
  }

  artistRows.push({
    artist: artist.name,
    slug: artist.slug,
    mirloReleases: mirloReleases.length,
    existingReleases: existing.length,
    ...artistBucket,
  });
}

// --- 3. Report -------------------------------------------------------------------

const totalMirloReleases = totals.tier2_exact + totals.tier3_fuzzy + totals.distinct;
const overlapping = totals.tier2_exact + totals.tier3_fuzzy;
const rate = totalMirloReleases === 0 ? null : overlapping / totalMirloReleases;

const summary = {
  catalogArtists: catalog.artists.length,
  ourMirloLinks: artistIdBySlug.size,
  measurableArtists: matchedArtists.length,
  totalMirloReleases,
  ...totals,
  overlapRate: rate,
};

if (asJson) {
  console.log(JSON.stringify({ summary, artists: artistRows, pairs }, null, 2));
} else {
  console.log('\nMirlo ↔ existing-catalogue release overlap');
  console.log('==========================================\n');
  console.log(`Canimus catalog (opted-in artists) : ${summary.catalogArtists}`);
  console.log(`Our stored mirlo artist links      : ${summary.ourMirloLinks}`);
  console.log(`Artists in both — the sample       : ${summary.measurableArtists}`);
  console.log(`Mirlo releases across that sample  : ${summary.totalMirloReleases}\n`);
  console.log(`  tier2_exact (auto-merges)        : ${totals.tier2_exact}`);
  console.log(`  tier3_fuzzy (queues for review)  : ${totals.tier3_fuzzy}`);
  console.log(`  distinct    (new release row)    : ${totals.distinct}\n`);
  console.log(
    rate === null
      ? 'Overlap rate                       : n/a — no Mirlo releases in the sample'
      : `Overlap rate                       : ${(rate * 100).toFixed(1)}%`
  );

  if (summary.measurableArtists < 10) {
    console.log(
      '\n⚠️  Sample is under 10 artists. Report the count alongside any rate quoted from it —\n' +
        '   a percentage off a handful of artists is a number with no confidence attached.'
    );
  }

  if (showPairs && pairs.length > 0) {
    console.log('\nMatched pairs\n-------------');
    for (const p of pairs) {
      console.log(`  [${p.tier}] ${p.artist}: "${p.mirlo}" ↔ "${p.existing}" (${p.platforms.join(', ')})`);
    }
  }
}
