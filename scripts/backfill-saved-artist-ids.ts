#!/usr/bin/env npx tsx
/**
 * Link the `saved_artists` rows whose `artist_id` is NULL to the artist they actually name.
 *
 * Why this exists: saving an artist from a search result used to send a synthetic search-pipeline
 * key (`rodneyowl`, `qobuz-robertlogan`, `nameonly-…`) rather than the artist's page slug, so
 * `findExistingArtist` missed and the row was written unlinked. Measured 2026-08-07: **25 of 37
 * live rows**. Every feature keyed on the artist was blind to them — the release feeds, the
 * /dashboard shortlist, and the `requestArtistCatalog` call that makes a save the strongest signal
 * to go and crawl someone.
 *
 * #426 fixed both live paths: the card now saves under `knownSlug`, and `getFeedReleasesForUser`
 * resolves the slug at read time so the existing rows already work in the feeds. This script
 * repairs the stored data itself, so the read-time fallback stops being load-bearing and the
 * *catalogue* trigger (which has no fallback) starts working for these artists on their next save.
 *
 * Usage:
 *   npx tsx scripts/backfill-saved-artist-ids.ts            # dry run (default) — prints every proposal
 *   npx tsx scripts/backfill-saved-artist-ids.ts --write    # apply
 *
 * Safety properties, in order of how much they matter:
 *
 *  - **Update-only, one column.** It sets `artist_id` on rows where it is currently NULL, by
 *    primary key, one row at a time. It never inserts, never deletes, and never touches any other
 *    column — including `artist_slug`, see the note below. A row it cannot resolve is left exactly
 *    as it is. Given the artist_links wipe of 2026-07-29, nothing here removes anything.
 *  - **The same resolution rules as the shipped read path** (`savedArtistIdsForUser` in db.ts):
 *    exact slug, then `artistSlug(artist_name)` *if the found artist's own name agrees*, then the
 *    alias table. `artistSlug` is imported rather than reimplemented so the two cannot drift.
 *  - **A name-derived match must prove itself.** A name is a far weaker key than a slug; without
 *    the name-agreement check a row with a generic name ("Music") would adopt an unrelated
 *    artist's releases, which puts someone else's record in a fan's calendar.
 *  - **No cataloguing is triggered.** Linking 25 artists must not dump 25 crawls on Bandcamp. The
 *    scheduled sweep already covers them.
 *
 * Deliberately NOT done here: rewriting `artist_slug` to the canonical form. It would fix the
 * cosmetic "the artist page still offers Save for an artist you saved" symptom, but the table has
 * a unique key on (user_id, artist_slug) and several users already hold *both* spellings — so a
 * rewrite can collide, and it would also change the key the client currently has in memory. The
 * dry run reports those rows so the decision can be made with the list in hand.
 */

import { createClient } from '@supabase/supabase-js';
import { artistSlug } from '../api/functions/db';

const WRITE = process.argv.includes('--write');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (source the repo .env).');
  process.exit(1);
}
const client = createClient(url, key);

interface SavedRow {
  id: string;
  user_id: string;
  artist_id: string | null;
  artist_slug: string | null;
  artist_name: string | null;
  deleted: boolean;
}

interface ArtistRow {
  id: string;
  slug: string;
  name: string;
  match_confidence: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prefixes the search pipeline puts on a synthetic result id. */
const SYNTHETIC_PREFIX = /^(qobuz|claimed|known|nameonly)-/;

/**
 * Does the saved row agree with itself?
 *
 * The name-agreement check alone is not enough, because a saved row's *name* can be junk too, and
 * junk matching junk still matches. Two real examples from the dry run:
 *
 *  - `nameonly-blixbyrd` stored the name **"Music"** — the search pipeline had misparsed Blixbyrd
 *    — and "Music" resolves to a real artists row also called "Music" whose only link is
 *    `https://bonkwave.org/music`, a Faircamp page path from the artist-as-release parsing bug.
 *  - `qobuz-mikeposner` stored **"Qobuz Mikeposner"**: `saved-artists.ts` title-cases the slug when
 *    the client sends no name, so the name is the slug and carries no independent evidence at all.
 *
 * The discriminator is that a *good* row's slug and name say the same thing — strip the synthetic
 * prefix, drop hyphens, and `qobuz-robertlogan`/"Robert Logan" agree while `nameonly-blixbyrd`/
 * "Music" do not. This is only applied to the name rule; an exact slug, alias or id match needs no
 * corroboration.
 *
 * What it deliberately does NOT do is re-hyphenate the leftover (`pearljam` → `pearl-jam`), which
 * would recover four more rows by guessing where the words divide. That is the kind of guess that
 * puts the wrong artist in someone's feed.
 */
function slugAndNameAgree(savedSlug: string, savedName: string): boolean {
  const remainder = savedSlug.toLowerCase().replace(SYNTHETIC_PREFIX, '').replace(/-/g, '');
  return remainder === artistSlug(savedName).replace(/-/g, '');
}

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

async function main() {
  const unlinked = await readAllPages<SavedRow>((from, to) =>
    client
      .from('saved_artists')
      .select('id, user_id, artist_id, artist_slug, artist_name, deleted')
      .is('artist_id', null)
      .range(from, to)
  );

  console.log(`${unlinked.length} saved_artists rows with a NULL artist_id`);
  console.log(`  live: ${unlinked.filter(r => !r.deleted).length}   tombstoned: ${unlinked.filter(r => r.deleted).length}\n`);
  if (unlinked.length === 0) return;

  // Every candidate slug the resolution rules could consult, looked up in one read.
  const candidates = new Set<string>();
  for (const row of unlinked) {
    if (row.artist_slug) candidates.add(row.artist_slug.toLowerCase());
    if (row.artist_name) candidates.add(artistSlug(row.artist_name));
  }
  candidates.delete('');

  const artists = await readAllPages<ArtistRow>((from, to) =>
    client.from('artists').select('id, slug, name, match_confidence').in('slug', [...candidates]).range(from, to)
  );
  const bySlug = new Map(artists.map(a => [a.slug.toLowerCase(), a]));
  const byId = new Map(artists.map(a => [a.id, a]));

  const aliases = await readAllPages<{ alias: string; artist_id: string }>((from, to) =>
    client.from('artist_slug_aliases').select('alias, artist_id').in('alias', [...candidates]).range(from, to)
  );
  const byAlias = new Map(aliases.map(a => [a.alias.toLowerCase(), a.artist_id]));

  // Which artists each user already has linked, so a proposal that duplicates one is flagged.
  const linked = await readAllPages<{ user_id: string; artist_id: string; artist_slug: string | null }>((from, to) =>
    client.from('saved_artists').select('user_id, artist_id, artist_slug').not('artist_id', 'is', null).range(from, to)
  );
  const alreadyLinked = new Set(linked.map(r => `${r.user_id}:${r.artist_id}`));

  const proposals: { row: SavedRow; artist: ArtistRow | { id: string; slug: string; name: string }; rule: string; duplicate: boolean }[] = [];
  const unresolved: SavedRow[] = [];

  for (const row of unlinked) {
    const slug = (row.artist_slug || '').toLowerCase();
    const derived = row.artist_name ? artistSlug(row.artist_name) : '';

    const direct = slug ? bySlug.get(slug) : undefined;
    const byName = derived ? bySlug.get(derived) : undefined;
    const aliasId = slug ? byAlias.get(slug) : undefined;

    let artist: ArtistRow | undefined;
    let rule = '';
    // A saved slug that is literally an artists.id is the strongest evidence there is — the client
    // sent the UUID instead of the slug, which ArtistPage's own comment records as a past bug.
    if (UUID.test(slug) && byId.has(slug)) {
      artist = byId.get(slug);
      rule = 'id';
    } else if (direct) {
      artist = direct;
      rule = 'slug';
    } else if (byName && artistSlug(byName.name) === derived && slugAndNameAgree(slug, row.artist_name || '')) {
      artist = byName;
      rule = 'name';
    } else if (aliasId) {
      const target = artists.find(a => a.id === aliasId);
      artist = target ?? { id: aliasId, slug: '(via alias)', name: '(via alias)' };
      rule = 'alias';
    }

    if (!artist) {
      unresolved.push(row);
      continue;
    }
    proposals.push({ row, artist, rule, duplicate: alreadyLinked.has(`${row.user_id}:${artist.id}`) });
  }

  console.log(`RESOLVED ${proposals.length}:\n`);
  console.log(`  ${'saved slug'.padEnd(26)} ${'saved name'.padEnd(22)} -> ${'artist slug'.padEnd(24)} ${'rule'.padEnd(5)} ${'confidence'.padEnd(11)} flags`);
  for (const p of proposals) {
    const flags = [p.row.deleted ? 'tombstoned' : '', p.duplicate ? 'DUP-of-existing-row' : ''].filter(Boolean).join(' ');
    console.log(
      `  ${(p.row.artist_slug || '').slice(0, 26).padEnd(26)} ${(p.row.artist_name || '').slice(0, 22).padEnd(22)} -> ${p.artist.slug.padEnd(24)} ${p.rule.padEnd(5)} ${(('match_confidence' in p.artist ? p.artist.match_confidence : '?') as string).padEnd(11)} ${flags}`
    );
  }

  if (unresolved.length > 0) {
    console.log(`\nUNRESOLVED ${unresolved.length} — left untouched:\n`);
    for (const r of unresolved) {
      console.log(`  ${(r.artist_slug || '').padEnd(26)} ${(r.artist_name || '').slice(0, 22).padEnd(22)} ${r.deleted ? '(tombstoned)' : ''}`);
    }
  }

  const dups = proposals.filter(p => p.duplicate);
  if (dups.length > 0) {
    console.log(
      `\n⚠️  ${dups.length} proposal(s) would give a user two rows for the same artist. Harmless to the` +
      `\n   feeds (ids are de-duplicated at read time) but worth a separate decision — this script` +
      `\n   does not merge or delete rows.`
    );
  }

  if (!WRITE) {
    console.log(`\nDRY RUN — nothing written. Re-run with --write to apply ${proposals.length} update(s).`);
    return;
  }

  console.log(`\nWriting ${proposals.length} update(s)…`);
  let ok = 0;
  const failures: string[] = [];
  for (const p of proposals) {
    // By primary key, and only where it is still NULL: if anything else linked this row between
    // the read and now, this writes nothing rather than overwriting that decision.
    const { error } = await client
      .from('saved_artists')
      .update({ artist_id: p.artist.id })
      .eq('id', p.row.id)
      .is('artist_id', null);
    if (error) failures.push(`${p.row.artist_slug}: ${error.message}`);
    else ok++;
  }

  console.log(`  updated ${ok}/${proposals.length}`);
  if (failures.length > 0) {
    console.log(`  ${failures.length} failed:`);
    for (const f of failures) console.log(`    ${f}`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
