/**
 * Generate a list of ~1000 mid-tier popular artists via Wikidata SPARQL query.
 *
 * Skips the top ~1000 mega-famous artists (who attract impersonators and don't
 * need indie music discovery) and takes the next 1000 — artists popular enough
 * to be searched but who actually benefit from being found on alternative platforms.
 *
 * Uses wikibase:sitelinks for fast ranking instead of counting sitelinks manually.
 * Runs multiple smaller queries to avoid Wikidata timeouts, then merges results.
 *
 * Output: data/artist-list.json
 * Usage: npx tsx scripts/generate-artist-list.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'data', 'artist-list.json');

const SKIP_TOP = 1000;  // Skip the top N mega-famous artists
const TAKE_COUNT = 3000; // Take the next N after skipping

interface ArtistEntry {
  name: string;
  slug: string;
  musicbrainzId: string;
}

interface WikidataBinding {
  artist?: { value: string };
  artistLabel?: { value: string };
  mbid?: { value: string };
  sites?: { value: string };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Fetch a large pool so we can skip the top 1000 and still have 3000+ left.
// Lower sitelink thresholds to reach deeper into the mid/long-tail.
const QUERIES: { label: string; sparql: string }[] = [
  {
    label: 'musical groups/bands',
    sparql: `
SELECT ?artist ?artistLabel ?mbid ?sites WHERE {
  ?artist wdt:P31 wd:Q215380 .       # instance of: musical group
  ?artist wdt:P434 ?mbid .           # has MusicBrainz ID
  ?artist wikibase:sitelinks ?sites .
  FILTER(?sites > 5)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
ORDER BY DESC(?sites)
LIMIT 3000
`,
  },
  {
    label: 'singers',
    sparql: `
SELECT ?artist ?artistLabel ?mbid ?sites WHERE {
  ?artist wdt:P31 wd:Q5 .            # human
  ?artist wdt:P106 wd:Q177220 .      # occupation: singer
  ?artist wdt:P434 ?mbid .           # has MusicBrainz ID
  ?artist wikibase:sitelinks ?sites .
  FILTER(?sites > 10)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
ORDER BY DESC(?sites)
LIMIT 3000
`,
  },
  {
    label: 'musicians',
    sparql: `
SELECT ?artist ?artistLabel ?mbid ?sites WHERE {
  ?artist wdt:P31 wd:Q5 .            # human
  ?artist wdt:P106 wd:Q639669 .      # occupation: musician
  ?artist wdt:P434 ?mbid .           # has MusicBrainz ID
  ?artist wikibase:sitelinks ?sites .
  FILTER(?sites > 10)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
ORDER BY DESC(?sites)
LIMIT 3000
`,
  },
  {
    label: 'songwriters',
    sparql: `
SELECT ?artist ?artistLabel ?mbid ?sites WHERE {
  ?artist wdt:P31 wd:Q5 .            # human
  ?artist wdt:P106 wd:Q753110 .      # occupation: songwriter
  ?artist wdt:P434 ?mbid .           # has MusicBrainz ID
  ?artist wikibase:sitelinks ?sites .
  FILTER(?sites > 10)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
ORDER BY DESC(?sites)
LIMIT 3000
`,
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runQuery(sparql: string, label: string, attempt = 1): Promise<WikidataBinding[]> {
  const url = 'https://query.wikidata.org/sparql';
  const params = new URLSearchParams({
    query: sparql,
    format: 'json',
  });

  console.log(`  Querying: ${label} (attempt ${attempt})...`);

  const response = await fetch(`${url}?${params}`, {
    headers: {
      'User-Agent': 'Unstream/1.0 (https://unstream.stream; support@unstream.stream)',
      Accept: 'application/sparql-results+json',
    },
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    if (attempt < 3) {
      const wait = attempt * 15000;
      console.log(`  Got ${response.status}, retrying in ${wait / 1000}s...`);
      await sleep(wait);
      return runQuery(sparql, label, attempt + 1);
    }
    throw new Error(`Wikidata query failed for "${label}": ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const bindings: WikidataBinding[] = data.results.bindings;
  console.log(`  Got ${bindings.length} results for ${label}`);
  return bindings;
}

async function main() {
  try {
    console.log('Fetching artists from Wikidata (targeting mid-tier popularity)...\n');

    const allBindings: WikidataBinding[] = [];

    for (const query of QUERIES) {
      const bindings = await runQuery(query.sparql, query.label);
      allBindings.push(...bindings);
      // Pause between queries to be nice to Wikidata
      await sleep(3000);
    }

    console.log(`\nTotal raw results: ${allBindings.length}`);

    // Deduplicate by slug, keeping the one with more sitelinks
    const artistMap = new Map<string, ArtistEntry & { sites: number }>();

    for (const binding of allBindings) {
      const name = binding.artistLabel?.value;
      const mbid = binding.mbid?.value;
      const sites = parseInt(binding.sites?.value || '0', 10);

      if (!name || !mbid) continue;

      // Skip entries where Wikidata returned a QID instead of a label
      if (/^Q\d+$/.test(name)) continue;

      const slug = slugify(name);
      if (!slug) continue;

      const existing = artistMap.get(slug);
      if (!existing || sites > existing.sites) {
        artistMap.set(slug, { name, slug, musicbrainzId: mbid, sites });
      }
    }

    // Sort by sitelink count, skip the top mega-famous artists, take the next batch
    const sorted = Array.from(artistMap.values()).sort((a, b) => b.sites - a.sites);

    console.log(`Deduplicated to ${sorted.length} unique artists total`);
    console.log(`Skipping top ${SKIP_TOP}, taking next ${TAKE_COUNT}`);

    if (sorted.length > SKIP_TOP) {
      console.log(`  Top artist skipped: "${sorted[0].name}" (${sorted[0].sites} sitelinks)`);
      console.log(`  Last artist skipped: "${sorted[Math.min(SKIP_TOP - 1, sorted.length - 1)].name}" (${sorted[Math.min(SKIP_TOP - 1, sorted.length - 1)].sites} sitelinks)`);
    }

    const selected = sorted.slice(SKIP_TOP, SKIP_TOP + TAKE_COUNT);

    if (selected.length > 0) {
      console.log(`  First selected: "${selected[0].name}" (${selected[0].sites} sitelinks)`);
      console.log(`  Last selected: "${selected[selected.length - 1].name}" (${selected[selected.length - 1].sites} sitelinks)`);
    }

    const artists: ArtistEntry[] = selected.map(({ name, slug, musicbrainzId }) => ({ name, slug, musicbrainzId }));

    // Ensure output directory exists
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

    writeFileSync(OUTPUT_PATH, JSON.stringify(artists, null, 2));
    console.log(`\nWrote ${artists.length} artists to ${OUTPUT_PATH}`);
  } catch (error) {
    console.error('Failed to generate artist list:', error);
    process.exit(1);
  }
}

main();
