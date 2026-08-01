#!/usr/bin/env npx tsx
/**
 * Backfill `artists` + `artist_links` rows for the artist pages we publish but never stored.
 *
 * Why this exists: `data/artists-manifest.json` (791 artists) feeds the sitemap and the generated
 * social posts, but /artist/:slug renders from Supabase — and rows only appear there when someone
 * *searches* an artist (`persistSearchResults`). Nothing ever seeded the published set, so at the
 * time of writing only 55 of the 791 had a row and the other 736 returned 404 to fans and to
 * Google. The static data under `data/artists/` has been orphaned since #274 moved the page onto
 * /api/artist-page; this script pours it into the database the page actually reads.
 *
 * Usage:
 *   npx tsx scripts/backfill-published-artist-rows.ts              # dry run (default)
 *   npx tsx scripts/backfill-published-artist-rows.ts --write      # actually insert
 *   npx tsx scripts/backfill-published-artist-rows.ts --limit=10   # try a small slice first
 *
 * Safety properties, in order of how much they matter:
 *
 *  - **Insert-only.** Any slug that already has a row is skipped untouched, whatever its state.
 *    Nothing here updates or deletes an existing artist or link. Claimed profiles therefore can't
 *    be affected even in principle — which is the point, given the artist_links wipe of 2026-07-29.
 *  - **The slug comes from the manifest, never derived from the name.** `artistSlug()` in db.ts
 *    strips accents to hyphens (`Jónsi` → `j-nsi`), and 34 of the 791 manifest slugs disagree with
 *    it. Deriving would file those artists under URLs the sitemap doesn't advertise, leaving the
 *    404 unfixed while looking successful.
 *  - **No cataloguing is triggered.** `persistSearchResults` requests a release catalogue for every
 *    artist with a Bandcamp link; doing that for 736 artists at once would dump hundreds of crawls
 *    on Bandcamp. Releases can be catalogued later, deliberately and in batches.
 *  - Link filtering reuses `isDirectLink` / `EXCLUDED_PLATFORMS` imported from db.ts, so a
 *    backfilled artist stores exactly what a searched artist would.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { isDirectLink, EXCLUDED_PLATFORMS } from '../api/functions/db';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface ManifestEntry {
  slug: string;
  name: string;
  imageUrl?: string | null;
}

interface StaticPlatform {
  sourceId: string;
  url: string;
  latestRelease?: unknown;
}

interface StaticArtist {
  id?: string;
  name: string;
  type?: string;
  imageUrl?: string | null;
  platforms?: StaticPlatform[];
  matchConfidence?: string;
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Source your .env before running this.`);
    process.exit(1);
  }
  return value;
}

const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_KEY'));

/** Slugs that already have an artists row, looked up in chunks to stay under URL length limits. */
async function findExistingSlugs(slugs: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let i = 0; i < slugs.length; i += 200) {
    const chunk = slugs.slice(i, i + 200);
    const { data, error } = await supabase.from('artists').select('slug').in('slug', chunk);
    if (error) {
      console.error('Failed to read existing artists:', error.message);
      process.exit(1);
    }
    for (const row of data) existing.add(row.slug);
  }
  return existing;
}

interface Candidate {
  slug: string;
  name: string;
  imageUrl: string | null;
  matchConfidence: 'verified' | 'unverified';
  links: Array<{ platform: string; url: string; latestRelease: unknown }>;
}

/** Read a published slug's static file and reduce it to what we'd store. Null if unusable. */
function buildCandidate(entry: ManifestEntry): Candidate | { skip: string } {
  const path = resolve(repoRoot, 'data/artists', `${entry.slug}.json`);
  if (!existsSync(path)) return { skip: 'no static file' };

  let parsed: StaticArtist[];
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as StaticArtist[];
  } catch {
    return { skip: 'unparseable static file' };
  }

  const artist = Array.isArray(parsed) ? parsed[0] : (parsed as unknown as StaticArtist);
  if (!artist?.name) return { skip: 'no artist in static file' };

  const links = (artist.platforms ?? [])
    .filter(p => !EXCLUDED_PLATFORMS.has(p.sourceId) && isDirectLink(p.url))
    .map(p => ({ platform: p.sourceId, url: p.url, latestRelease: p.latestRelease ?? null }));

  // Same rule persistSearchResults applies: an artist with no real link has no page worth serving.
  if (links.length === 0) return { skip: 'no direct links after filtering' };

  return {
    slug: entry.slug,
    name: artist.name,
    imageUrl: artist.imageUrl || entry.imageUrl || null,
    matchConfidence: artist.matchConfidence === 'verified' ? 'verified' : 'unverified',
    links,
  };
}

async function insertCandidate(c: Candidate): Promise<string | null> {
  const { data, error } = await supabase
    .from('artists')
    .insert({
      slug: c.slug,
      name: c.name,
      image_url: c.imageUrl,
      match_confidence: c.matchConfidence,
      source: 'auto',
    })
    .select('id')
    .single();

  if (error || !data) return `artist insert failed: ${error?.message ?? 'no row returned'}`;

  // Deduped by platform: Postgres rejects a bulk insert touching the same conflict key twice, and
  // a couple of static files list a platform more than once.
  const byPlatform = new Map(c.links.map((l, index) => [l.platform, {
    artist_id: data.id,
    platform: l.platform,
    url: l.url,
    source: 'search',
    is_direct: true,
    latest_release: l.latestRelease,
    display_order: index,
  }]));

  const { error: linkError } = await supabase.from('artist_links').insert([...byPlatform.values()]);
  if (linkError) return `links insert failed: ${linkError.message}`;

  return null;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, 'data/artists-manifest.json'), 'utf8')
  ) as ManifestEntry[];

  console.log(`Manifest: ${manifest.length} published artists`);

  const existing = await findExistingSlugs(manifest.map(e => e.slug));
  console.log(`Already have a row: ${existing.size}`);

  const missing = manifest.filter(e => !existing.has(e.slug));
  console.log(`Missing a row: ${missing.length}\n`);

  const candidates: Candidate[] = [];
  const skips = new Map<string, string[]>();

  for (const entry of missing) {
    const result = buildCandidate(entry);
    if ('skip' in result) {
      const list = skips.get(result.skip) ?? [];
      list.push(entry.slug);
      skips.set(result.skip, list);
    } else {
      candidates.push(result);
    }
  }

  for (const [reason, slugs] of skips) {
    console.log(`Skipped — ${reason}: ${slugs.length}`);
    console.log(`  ${slugs.slice(0, 8).join(', ')}${slugs.length > 8 ? ' …' : ''}`);
  }

  const planned = candidates.slice(0, limit === Infinity ? candidates.length : limit);
  const totalLinks = planned.reduce((sum, c) => sum + c.links.length, 0);
  console.log(`\nWould insert ${planned.length} artists and ${totalLinks} links.`);
  console.log('Sample:');
  for (const c of planned.slice(0, 5)) {
    console.log(`  ${c.slug.padEnd(24)} ${c.matchConfidence.padEnd(10)} ${c.links.length} links  ${c.links.map(l => l.platform).join(', ')}`);
  }

  if (!write) {
    console.log('\nDry run — nothing written. Re-run with --write to insert.');
    return;
  }

  console.log('\nWriting…');
  let inserted = 0;
  const failures: string[] = [];

  for (const c of planned) {
    const error = await insertCandidate(c);
    if (error) {
      failures.push(`${c.slug}: ${error}`);
    } else {
      inserted++;
      if (inserted % 50 === 0) console.log(`  ${inserted}/${planned.length}`);
    }
  }

  console.log(`\nInserted ${inserted} artists.`);
  if (failures.length) {
    console.log(`${failures.length} failed:`);
    for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main();
