#!/usr/bin/env npx tsx
/**
 * Re-derive `city` / `country` / `country_code` on the `artists` rows that already carry a
 * location, using the fixed MusicBrainz area parsing.
 *
 * Why this exists: locations used to be assembled field by field across sources, so a row
 * could take its city from MusicBrainz and its region from a Bandcamp page. The Foo Fighters
 * page read **"Seattle, California"** — MusicBrainz's begin-area beside the region on
 * foofighters.bandcamp.com. Measured against production on 2026-08-09, 244 rows carried a
 * location and the same merge had produced "Brooklyn, Florida" (Honeycrush), "Basel, New York"
 * (Zeal & Ardor, who are Swiss), "Issaquah, Oregon" (Modest Mouse, who are from Washington),
 * "Düsseldorf, Russia" (Pole) and "Michigan, Michigan" (Citizen). A second defect classified
 * MusicBrainz areas by `type`, which is null on most community-entered data, so country areas
 * were filed as cities — that is where the "United States" and "Germany" city values came from.
 *
 * The code fix means every location written from now on comes whole from one source. This
 * script repairs the rows that were written before it. Without it the bad strings sit on the
 * artist pages until somebody happens to search each artist again.
 *
 * Usage (source the repo .env first, for SUPABASE_URL and SUPABASE_SERVICE_KEY):
 *   npx tsx scripts/backfill-artist-locations.ts            # dry run (default) — prints every change
 *   npx tsx scripts/backfill-artist-locations.ts --write    # apply
 *   npx tsx scripts/backfill-artist-locations.ts --limit=20 # first 20 rows only
 *
 * Safety properties:
 *
 *  - **Update-only, three columns, by primary key.** It never inserts and never deletes. A row
 *    it cannot re-derive is left exactly as it is — including its current, possibly wrong,
 *    value. Leaving a wrong string alone is the right failure mode here; blanking it would
 *    lose the only location an artist has, and blanking is not recoverable from this script.
 *  - **The same gates as the live pipeline.** `musicBrainzArtistQuery`, the score >= 95 floor
 *    and the `normalizeForComparison` name check are imported from the shipped code rather than
 *    restated, so this cannot drift from what a real search would compute.
 *  - **MusicBrainz only.** The live pipeline falls back to Bandcamp and Mirlo when MusicBrainz
 *    has no match; this script does not. A row whose location came from Bandcamp alone was
 *    already single-sourced and is not what went wrong — and the Bandcamp probe can match the
 *    wrong account (that is how Honeycrush got a Brooklyn/Florida row in the first place), so
 *    re-running it unattended over 244 artists would risk introducing errors while fixing them.
 *    Those rows re-derive on their next real search.
 *  - **One request per second.** MusicBrainz allows one; two per artist means roughly nine
 *    minutes for 244 rows. Do not parallelise it.
 */

import { createClient } from '@supabase/supabase-js';
import { parseMusicBrainzArea, type ArtistLocation, type MusicBrainzArea } from '../api/search/enrichment';
import { musicBrainzArtistQuery, normalizeForComparison } from '../api/functions/search-utils';

const WRITE = process.argv.includes('--write');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (source the repo .env).');
  process.exit(1);
}
const client = createClient(url, key);

const USER_AGENT = 'Unstream/1.0 (https://unstream.stream)';
const MB_DELAY_MS = 1100;

interface ArtistRow {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  country: string | null;
  country_code: string | null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Read a whole table through PostgREST, a page at a time — `.limit()` silently caps at 1,000. */
async function readAllPages<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await build(from, from + step - 1);
    if (error) throw new Error(`read failed: ${JSON.stringify(error)}`);
    const rows = (data as T[]) || [];
    out.push(...rows);
    if (rows.length < step) return out;
  }
}

/** How the row reads on the page: `city, country ?? countryCode`, same as every client. */
function display(location: ArtistLocation | undefined): string {
  if (!location) return '(none)';
  return [location.city, location.country ?? location.countryCode].filter(Boolean).join(', ') || '(none)';
}

/**
 * Would writing `derived` throw away a real city?
 *
 * MusicBrainz often knows an artist only by country. Overwriting AZALI's stored
 * "Seattle, Washington" with a bare "United States" trades a wrong-ish region for no
 * location at all, which is not a repair. The live pipeline never does this — pickLocation
 * prefers whichever source has a city, so a real search keeps the Bandcamp value — and this
 * script should not either.
 *
 * The exception is a stored "city" that was never a city: the old area parsing filed country
 * names in that column, so Ягода reads "Russia, RU". When the stored city is just the derived
 * country said twice, replacing it loses nothing.
 */
function wouldLoseACity(stored: ArtistLocation, derived: ArtistLocation): boolean {
  if (!stored.city || derived.city) return false;
  const sameAsCountry = stored.city.toLowerCase() === (derived.country ?? '').toLowerCase();
  return !sameAsCountry;
}

/**
 * The location the live pipeline would derive from MusicBrainz today, or null when MusicBrainz
 * did not confidently identify the artist.
 *
 * `null` is also what an upstream failure returns. That is deliberate: it means "leave the row
 * alone", never "this artist has no location".
 */
async function deriveFromMusicBrainz(name: string): Promise<ArtistLocation | null> {
  const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(musicBrainzArtistQuery(name))}&fmt=json&limit=1`;
  const searchResponse = await globalThis.fetch(searchUrl, { headers: { 'User-Agent': USER_AGENT } });
  await sleep(MB_DELAY_MS);
  if (!searchResponse.ok) return null;

  const searchData = await searchResponse.json() as { artists?: { id: string; name: string; score: number }[] };
  const artist = searchData.artists?.[0];
  if (!artist || artist.score < 95) return null;

  const queryNormalized = normalizeForComparison(name);
  const artistNormalized = normalizeForComparison(artist.name);
  const isNameMatch = queryNormalized === artistNormalized ||
    queryNormalized.includes(artistNormalized) && artistNormalized.length > queryNormalized.length * 0.7 ||
    artistNormalized.includes(queryNormalized) && queryNormalized.length > artistNormalized.length * 0.7;
  if (!isNameMatch) return null;

  const lookupResponse = await globalThis.fetch(
    `https://musicbrainz.org/ws/2/artist/${artist.id}?fmt=json`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  await sleep(MB_DELAY_MS);
  if (!lookupResponse.ok) return null;

  const data = await lookupResponse.json() as {
    country?: string;
    area?: MusicBrainzArea;
    'begin-area'?: MusicBrainzArea;
  };
  return parseMusicBrainzArea(data.area, data['begin-area'], data.country) ?? null;
}

async function main() {
  const rows = await readAllPages<ArtistRow>((from, to) =>
    client
      .from('artists')
      .select('id, slug, name, city, country, country_code')
      .or('city.not.is.null,country.not.is.null,country_code.not.is.null')
      .order('slug')
      .range(from, to)
  );

  const targets = rows.slice(0, LIMIT);
  console.log(`${rows.length} artist rows carry a location; processing ${targets.length}.`);
  console.log(WRITE ? 'Mode: WRITE\n' : 'Mode: dry run (pass --write to apply)\n');

  let changed = 0;
  let unchanged = 0;
  let kept = 0;
  let skipped = 0;

  for (const row of targets) {
    const stored: ArtistLocation = {
      ...(row.city ? { city: row.city } : {}),
      ...(row.country ? { country: row.country } : {}),
      ...(row.country_code ? { countryCode: row.country_code } : {}),
    };

    let derived: ArtistLocation | null;
    try {
      derived = await deriveFromMusicBrainz(row.name);
    } catch (error) {
      console.log(`SKIP    ${row.slug} — MusicBrainz lookup failed: ${(error as Error).message}`);
      skipped++;
      continue;
    }

    if (!derived) {
      skipped++;
      continue;
    }

    if (display(derived) === display(stored) && derived.countryCode === stored.countryCode) {
      unchanged++;
      continue;
    }

    if (wouldLoseACity(stored, derived)) {
      console.log(`KEEP    ${row.name}: "${display(stored)}" (MusicBrainz only offers "${display(derived)}")`);
      kept++;
      continue;
    }

    console.log(`CHANGE  ${row.name}: "${display(stored)}" -> "${display(derived)}"`);
    changed++;

    if (WRITE) {
      const { error } = await client
        .from('artists')
        .update({
          city: derived.city ?? null,
          country: derived.country ?? null,
          country_code: derived.countryCode ?? null,
        })
        .eq('id', row.id);
      if (error) console.error(`  write failed for ${row.slug}: ${JSON.stringify(error)}`);
    }
  }

  console.log(`\n${changed} changed, ${unchanged} already correct, ${kept} kept (MusicBrainz less specific), ${skipped} left alone (no confident MusicBrainz match).`);
  if (!WRITE && changed > 0) console.log('Dry run — nothing was written. Re-run with --write to apply.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
