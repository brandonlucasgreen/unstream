/**
 * Catalog one artist's releases in production, on demand.
 *
 * Usage:
 *   npm run catalog:artist -- kid-lightbulbs
 *   npm run catalog:artist -- kid-lightbulbs --force     # ignore the 7-day cooldown
 *   npm run catalog:artist -- "Kid Lightbulbs"           # name or slug, both work
 *
 * Cataloging is normally demand-driven — a fan saving an artist, or a search resolving one —
 * which is deliberate (see "Pages are built on demand" in the V1 scope). This is the admin
 * escape hatch for when you want a specific artist catalogued now: seeding a demo, checking a
 * parser change against a real catalog, or filling in your own profile.
 *
 * It invokes the same production background function those triggers invoke, so the crawl
 * budgets, the cooldown, the hourly cap and the per-artist backoff all still apply — this
 * script has no privileged path through them. `--force` clears this artist's cooldown first,
 * which is the one thing it can do that a fan can't.
 *
 * Requires INTERNAL_FUNCTION_SECRET in the environment (or in .env). It is the same secret the
 * function checks; get it from Netlify → Site configuration → Environment variables. The script
 * never prints it.
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { resolve } from 'path';

config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const SITE = process.env.UNSTREAM_SITE_URL || 'https://unstream.stream';

const args = process.argv.slice(2);
const force = args.includes('--force');
const query = args.find(a => !a.startsWith('--'));

if (!query) {
  console.error('Usage: npm run catalog:artist -- <artist-slug-or-name> [--force]');
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (they live in .env).');
  process.exit(1);
}

const db = createClient(supabaseUrl, supabaseKey);

// ---------------------------------------------------------------------------
// Find the artist — and be loud about near-misses
// ---------------------------------------------------------------------------

const { data: matches, error: matchError } = await db
  .from('artists')
  .select('id, name, slug')
  .or(`slug.eq.${query},name.ilike.${query}`);

if (matchError) {
  console.error('Lookup failed:', matchError.message);
  process.exit(1);
}

let candidates = matches ?? [];

if (candidates.length === 0) {
  // Near-misses matter here: this project has several artists whose slugs differ only by a
  // hyphen ("kidlightbulbs" and "kid-lightbulbs" are separate rows with different links), and
  // silently cataloging the wrong one wastes a crawl and writes releases under the wrong artist.
  const { data: fuzzy } = await db
    .from('artists')
    .select('id, name, slug')
    .ilike('slug', `%${query.replace(/[^a-z0-9]/gi, '')}%`)
    .limit(10);

  console.error(`No artist with slug or name "${query}".`);
  if (fuzzy?.length) {
    console.error('\nDid you mean:');
    for (const a of fuzzy) console.error(`  ${a.slug}  (${a.name})`);
  }
  process.exit(1);
}

if (candidates.length > 1) {
  console.error(`"${query}" matches ${candidates.length} artists — pass an exact slug:`);
  for (const a of candidates) console.error(`  ${a.slug}  (${a.name})`);
  process.exit(1);
}

const artist = candidates[0];

// A Bandcamp link is the whole input to ingest. Without one the background function records
// "no bandcamp link stored" and does nothing, which is easy to mistake for a broken crawl.
const { data: links } = await db
  .from('artist_links')
  .select('url')
  .eq('artist_id', artist.id)
  .eq('platform', 'bandcamp');

if (!links?.length) {
  console.error(`${artist.slug} has no Bandcamp link, so there is nothing to catalog from.`);
  console.error('Ingest is Bandcamp-only today. Add the link to the profile first.');
  process.exit(1);
}

console.log(`\n${artist.name} (${artist.slug})`);
console.log(`  ${links[0].url}`);

// ---------------------------------------------------------------------------
// Clear the cooldown if asked
// ---------------------------------------------------------------------------

const { data: priorState } = await db
  .from('release_catalog_state')
  .select('last_catalogued_at, releases_found, releases_detailed, consecutive_failures, last_error')
  .eq('artist_id', artist.id)
  .maybeSingle();

if (priorState) {
  console.log(`  previously: ${priorState.releases_found ?? 0} releases, ` +
    `${priorState.releases_detailed ?? 0} priced` +
    (priorState.last_error ? ` — last error: ${priorState.last_error}` : ''));
}

if (force && priorState) {
  // Backdated rather than deleted: the row also carries the failure counter and the last error,
  // which are worth keeping. Two hours clears both the cooldown and the exponential backoff.
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const { error } = await db
    .from('release_catalog_state')
    .update({ last_catalogued_at: null, last_attempted_at: twoHoursAgo, consecutive_failures: 0 })
    .eq('artist_id', artist.id);

  if (error) {
    console.error('Could not clear the cooldown:', error.message);
    process.exit(1);
  }
  console.log('  cooldown cleared (--force)');
}

// ---------------------------------------------------------------------------
// Invoke
// ---------------------------------------------------------------------------

// Checked here rather than up front so the artist lookup and the state readout above work
// without it — that half of this script is a useful "what do we know about this artist"
// command on its own, and it needs no credential beyond the Supabase key already in .env.
const secret = process.env.INTERNAL_FUNCTION_SECRET;
if (!secret) {
  console.error('\nINTERNAL_FUNCTION_SECRET is not set, so the crawl cannot be requested.');
  console.error('Netlify → Site configuration → Environment variables. Add it to .env, or:');
  console.error('  INTERNAL_FUNCTION_SECRET=… npm run catalog:artist -- <artist>');
  process.exit(1);
}

console.log(`\nAsking ${SITE} to catalog it …`);

const response = await fetch(`${SITE}/.netlify/functions/catalog-artist-background`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
  body: JSON.stringify({ artistIds: [artist.id], trigger: 'saved' }),
});

// A background function returns 202 the moment it accepts the job and runs afterwards, so this
// status says nothing about whether the crawl worked — including whether the secret was right.
// The state table below is the only real answer.
if (response.status !== 202 && !response.ok) {
  console.error(`Unexpected response: ${response.status}`);
  process.exit(1);
}
console.log(`  accepted (${response.status}) — the crawl runs in the background`);

// ---------------------------------------------------------------------------
// Wait for the outcome
// ---------------------------------------------------------------------------

const before = priorState?.last_catalogued_at ?? null;
const deadline = Date.now() + 120_000;

process.stdout.write('  waiting');

while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 5_000));
  process.stdout.write('.');

  const { data: state } = await db
    .from('release_catalog_state')
    .select('last_catalogued_at, releases_found, releases_detailed, last_error, consecutive_failures')
    .eq('artist_id', artist.id)
    .maybeSingle();

  if (!state) continue;
  if (state.last_error && state.consecutive_failures > (priorState?.consecutive_failures ?? 0)) {
    console.log(`\n\n  FAILED: ${state.last_error}\n`);
    process.exit(2);
  }
  if (state.last_catalogued_at && state.last_catalogued_at !== before) {
    console.log(`\n\n  ${state.releases_found} releases, ${state.releases_detailed ?? 0} with prices\n`);

    const { data: sample } = await db
      .from('releases')
      .select('slug, title, release_date, release_sources(release_offers(format, price, currency, availability))')
      .eq('artist_id', artist.id)
      .order('release_date', { ascending: false, nullsFirst: false })
      .limit(5);

    for (const r of sample ?? []) {
      const offers = (r.release_sources as { release_offers: { format: string; price: number | null }[] }[])
        .flatMap(s => s.release_offers)
        .map(o => `${o.format} ${o.price ?? '—'}`)
        .join(', ');
      console.log(`  ${(r.release_date ?? 'no date').padEnd(12)} ${r.title}`);
      if (offers) console.log(`               ${offers}`);
      console.log(`               ${SITE}/a/${artist.slug}/${r.slug}`);
    }
    console.log('');
    process.exit(0);
  }
}

console.log('\n\n  Still running after 2 minutes. A full catalog with prices can take a few');
console.log('  minutes — re-run to see where it got to, or check release_catalog_state.\n');
