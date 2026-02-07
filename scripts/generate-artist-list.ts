/**
 * Generate a list of ~1000 popular artists via Wikidata SPARQL query.
 * Artists are ranked by Wikipedia sitelink count and filtered to those
 * with a MusicBrainz ID (Wikidata property P434).
 *
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

// Split into separate queries to avoid Wikidata timeouts
const QUERIES: { label: string; sparql: string }[] = [
  {
    label: 'musical groups/bands',
    sparql: `
SELECT ?artist ?artistLabel ?mbid (COUNT(DISTINCT ?sitelink) AS ?sites) WHERE {
  ?artist wdt:P31 wd:Q215380 .     # instance of: musical group
  ?artist wdt:P434 ?mbid .         # has MusicBrainz ID
  ?sitelink schema:about ?artist .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
GROUP BY ?artist ?artistLabel ?mbid
HAVING (COUNT(DISTINCT ?sitelink) > 15)
ORDER BY DESC(?sites)
LIMIT 600
`,
  },
  {
    label: 'singers',
    sparql: `
SELECT ?artist ?artistLabel ?mbid (COUNT(DISTINCT ?sitelink) AS ?sites) WHERE {
  ?artist wdt:P31 wd:Q5 .          # human
  ?artist wdt:P106 wd:Q177220 .    # occupation: singer
  ?artist wdt:P434 ?mbid .         # has MusicBrainz ID
  ?sitelink schema:about ?artist .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
GROUP BY ?artist ?artistLabel ?mbid
HAVING (COUNT(DISTINCT ?sitelink) > 30)
ORDER BY DESC(?sites)
LIMIT 500
`,
  },
  {
    label: 'musicians',
    sparql: `
SELECT ?artist ?artistLabel ?mbid (COUNT(DISTINCT ?sitelink) AS ?sites) WHERE {
  ?artist wdt:P31 wd:Q5 .          # human
  ?artist wdt:P106 wd:Q639669 .    # occupation: musician
  ?artist wdt:P434 ?mbid .         # has MusicBrainz ID
  ?sitelink schema:about ?artist .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
GROUP BY ?artist ?artistLabel ?mbid
HAVING (COUNT(DISTINCT ?sitelink) > 30)
ORDER BY DESC(?sites)
LIMIT 500
`,
  },
  {
    label: 'songwriters',
    sparql: `
SELECT ?artist ?artistLabel ?mbid (COUNT(DISTINCT ?sitelink) AS ?sites) WHERE {
  ?artist wdt:P31 wd:Q5 .          # human
  ?artist wdt:P106 wd:Q753110 .    # occupation: songwriter
  ?artist wdt:P434 ?mbid .         # has MusicBrainz ID
  ?sitelink schema:about ?artist .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
GROUP BY ?artist ?artistLabel ?mbid
HAVING (COUNT(DISTINCT ?sitelink) > 30)
ORDER BY DESC(?sites)
LIMIT 500
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
      console.log(`  Got ${response.status}, retrying in 10s...`);
      await sleep(10000);
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
    console.log('Fetching popular artists from Wikidata...\n');

    const allBindings: WikidataBinding[] = [];

    for (const query of QUERIES) {
      const bindings = await runQuery(query.sparql, query.label);
      allBindings.push(...bindings);
      // Pause between queries to be nice to Wikidata
      await sleep(2000);
    }

    console.log(`\nTotal raw results: ${allBindings.length}`);

    // Deduplicate by slug, keeping the one with more sitelinks
    const artistMap = new Map<string, ArtistEntry & { sites: number }>();

    for (const binding of allBindings) {
      const name = binding.artistLabel?.value;
      const mbid = binding.mbid?.value;
      const sites = parseInt(binding.sites?.value || '0', 10);

      if (!name || !mbid) continue;

      const slug = slugify(name);
      if (!slug) continue;

      const existing = artistMap.get(slug);
      if (!existing || sites > existing.sites) {
        artistMap.set(slug, { name, slug, musicbrainzId: mbid, sites });
      }
    }

    // Sort by sitelink count (most popular first) and take top ~1000
    const artists: ArtistEntry[] = Array.from(artistMap.values())
      .sort((a, b) => b.sites - a.sites)
      .slice(0, 1000)
      .map(({ name, slug, musicbrainzId }) => ({ name, slug, musicbrainzId }));

    console.log(`Deduplicated to ${artists.length} unique artists`);

    // Ensure output directory exists
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

    writeFileSync(OUTPUT_PATH, JSON.stringify(artists, null, 2));
    console.log(`Wrote ${artists.length} artists to ${OUTPUT_PATH}`);
  } catch (error) {
    console.error('Failed to generate artist list:', error);
    process.exit(1);
  }
}

main();
