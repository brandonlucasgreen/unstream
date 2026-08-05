/**
 * Delete artist rows that must not exist: entities that are not musical acts
 * (api/lib/non-artist-names.ts) and acts excluded on ethical grounds
 * (api/lib/excluded-artists.ts).
 *
 * Both lists are also the gate in `persistSearchResults` that stops a search recreating those
 * rows. This script only removes what is already stored; the gate is what makes the removal
 * stick, so the two must stay together.
 *
 * Usage:
 *   npx tsx scripts/prune-non-artist-rows.ts            # dry run — lists what would go
 *   npx tsx scripts/prune-non-artist-rows.ts --apply
 *
 * Dry run is the default; --apply is the only thing that writes.
 *
 * Deleting an artist cascades to artist_links, artist_profiles, verification_requests,
 * artist_analytics, releases (and release_sources / release_offers), release_catalog_state,
 * artist_slug_aliases and artist_duplicate_dismissals. So the dry run prints those counts and the
 * script REFUSES to delete a row that has a claimed profile or that somebody has saved — either
 * means a human is attached to it and the name is more likely a collision with a real artist than
 * junk. Fix the list, don't force it through.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY (or a .env at the repo root).
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'path';
import { NON_ARTIST_SLUGS } from '../api/lib/non-artist-names';
import { EXCLUDED_ARTIST_SLUGS } from '../api/lib/excluded-artists';

config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Set them in .env or environment.');
  process.exit(1);
}
const client = createClient(url, key);
const apply = process.argv.includes('--apply');

interface Target {
  id: string;
  slug: string;
  name: string;
  links: number;
  releases: number;
  analytics: number;
  hasProfile: boolean;
  saves: number;
}

async function count(table: string, column: string, value: string): Promise<number> {
  const { count: n, error } = await client
    .from(table)
    .select(column, { count: 'exact', head: true })
    .eq(column, value);
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

async function main() {
  const slugs = [...new Set([...NON_ARTIST_SLUGS, ...EXCLUDED_ARTIST_SLUGS])];
  const { data: rows, error } = await client
    .from('artists')
    .select('id, slug, name, match_confidence')
    .in('slug', slugs);
  if (error) {
    console.error('Failed to read artists:', error.message);
    process.exit(1);
  }

  const stored = rows || [];
  console.log(`${slugs.length} denylisted slugs, ${stored.length} present in the database\n`);
  const missing = slugs.filter(s => !stored.some(r => r.slug === s));
  if (missing.length) console.log(`already absent: ${missing.join(', ')}\n`);
  if (stored.length === 0) return;

  const targets: Target[] = [];
  for (const row of stored) {
    targets.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      links: await count('artist_links', 'artist_id', row.id),
      releases: await count('releases', 'artist_id', row.id),
      analytics: await count('artist_analytics', 'artist_id', row.id),
      hasProfile: (await count('artist_profiles', 'artist_id', row.id)) > 0,
      saves: await count('saved_artists', 'artist_slug', row.slug),
    });
  }

  const blocked = targets.filter(t => t.hasProfile || t.saves > 0);
  const removable = targets.filter(t => !t.hasProfile && t.saves === 0);

  for (const t of removable) {
    console.log(
      `  DELETE ${t.slug.padEnd(24)} "${t.name}"  ` +
        `${t.links} links, ${t.releases} releases, ${t.analytics} analytics rows`
    );
  }
  for (const t of blocked) {
    const why = [t.hasProfile ? 'has a claimed profile' : null, t.saves ? `${t.saves} saves` : null]
      .filter(Boolean)
      .join(', ');
    console.log(`  SKIP   ${t.slug.padEnd(24)} "${t.name}"  ${why} — review the denylist entry`);
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to delete ${removable.length} row(s).`);
    return;
  }

  for (const t of removable) {
    const { error: deleteError } = await client.from('artists').delete().eq('id', t.id);
    if (deleteError) {
      console.error(`Failed to delete ${t.slug}: ${deleteError.message}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`deleted ${t.slug}`);
  }
  console.log(`\nDone. ${blocked.length} row(s) skipped.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
