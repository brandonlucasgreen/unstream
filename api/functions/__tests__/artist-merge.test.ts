// Merging duplicate artist rows: what counts as evidence, and what the merge actually writes.
//
// This is the most destructive code in the repo — it deletes artist rows and rewrites six tables —
// so the tests assert the *sequence* of writes, not just the outcome. Two rules carry the most
// weight, both learned from real data on 2026-08-03:
//
//   - Name similarity is NOT evidence. `Tiger Cub` and `Tigercub` are different bands (zero shared
//     release titles), as are `Honeycrush` (Brooklyn) and `Honey Crush` (Orlando). Merging on names
//     alone would recombine what an earlier fix deliberately separated.
//   - `saved_artists` has no foreign key and is keyed by (user_id, artist_slug), with artist_id set
//     to NULL on delete. So a merge that only reassigns artist_id leaves fans' saves pointing at a
//     dead slug — silently, because the row survives by design.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Op { table: string; kind: 'select' | 'update' | 'delete' | 'upsert'; payload?: unknown }

const ops: Op[] = [];
const tables: Record<string, Record<string, unknown>[]> = {};

function makeClient() {
  const match = (rows: Record<string, unknown>[], filters: [string, unknown][], ins: [string, unknown[]][]) =>
    rows.filter(r => filters.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c])));

  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const ins: [string, unknown[]][] = [];
      const rowsOf = () => (tables[table] ??= []);

      const builder: Record<string, unknown> = {
        select() {
          ops.push({ table, kind: 'select' });
          return builder;
        },
        eq(c: string, v: unknown) { filters.push([c, v]); return builder; },
        in(c: string, v: unknown[]) { ins.push([c, v]); return builder; },
        order() { return builder; },
        range(from: number, to: number) {
          const rows = match(rowsOf(), filters, ins).slice(from, to + 1);
          return Promise.resolve({ data: rows, error: null });
        },
        maybeSingle() {
          const rows = match(rowsOf(), filters, ins);
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        update(patch: Record<string, unknown>) {
          const apply = () => {
            const hit = match(rowsOf(), filters, ins);
            ops.push({ table, kind: 'update', payload: { patch, count: hit.length } });
            for (const r of hit) Object.assign(r, patch);
            return Promise.resolve({ data: null, error: null });
          };
          return { eq: (c: string, v: unknown) => { filters.push([c, v]); return apply(); },
                   in: (c: string, v: unknown[]) => { ins.push([c, v]); return apply(); } };
        },
        delete() {
          const apply = () => {
            const hit = match(rowsOf(), filters, ins);
            ops.push({ table, kind: 'delete', payload: { count: hit.length } });
            tables[table] = rowsOf().filter(r => !hit.includes(r));
            return Promise.resolve({ data: null, error: null });
          };
          return { eq: (c: string, v: unknown) => { filters.push([c, v]); return apply(); },
                   in: (c: string, v: unknown[]) => { ins.push([c, v]); return apply(); } };
        },
        upsert(row: Record<string, unknown>) {
          ops.push({ table, kind: 'upsert', payload: row });
          rowsOf().push(row);
          return Promise.resolve({ data: null, error: null });
        },
        then(res: (r: unknown) => unknown) {
          return Promise.resolve({ data: match(rowsOf(), filters, ins), error: null }).then(res);
        },
      };
      return builder;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { findDuplicateArtistPairs, mergeArtistPair, findReslugCandidates, reslugArtist } =
  await import('../artist-merge');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = makeClient() as any;

function artist(id: string, name: string, slug: string, confidence = 'unverified') {
  return { id, name, slug, match_confidence: confidence };
}

beforeEach(() => {
  ops.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  tables.artists = [];
  tables.artist_links = [];
  tables.releases = [];
  tables.artist_profiles = [];
  tables.artist_analytics = [];
  tables.release_catalog_state = [];
  tables.verification_requests = [];
  tables.saved_artists = [];
  tables.artist_slug_aliases = [];
});

async function onlyPair() {
  const r = await findDuplicateArtistPairs(client);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('unreachable');
  expect(r.pairs).toHaveLength(1);
  return r.pairs[0];
}

describe('findDuplicateArtistPairs — evidence', () => {
  it('calls a machine-key duplicate provenance', async () => {
    // The #338 signature: the loser's name IS normalizeForComparison(winner's name). Nothing else
    // produces that, so the pair is one artist by construction.
    tables.artists = [artist('w', 'Kid Lightbulbs', 'kid-lightbulbs', 'claimed'),
                      artist('l', 'kidlightbulbs', 'kidlightbulbs')];
    const pair = await onlyPair();
    expect(pair.evidence).toBe('provenance');
    expect(pair.winner.id).toBe('w');
    expect(pair.blockers).toEqual([]);
  });

  it('calls a pair with shared release titles release-overlap', async () => {
    tables.artists = [artist('w', 'Big Thief', 'big-thief'), artist('l', 'Bigthief', 'bigthief')];
    tables.releases = [
      { id: 'r1', artist_id: 'w', match_key: 'dandelion' },
      { id: 'r2', artist_id: 'l', match_key: 'dandelion' },
      { id: 'r3', artist_id: 'l', match_key: 'vampireempire' },
    ];
    const pair = await onlyPair();
    expect(pair.evidence).toBe('release-overlap');
    expect(pair.sharedTitles).toEqual(['dandelion']);
  });

  it('calls a pair that differs only by accents accent-fold', async () => {
    // What fans actually reported: searching "bjork" landed on the 1-link stub, not the real row.
    tables.artists = [artist('w', 'Björk', 'bj-rk'), artist('l', 'Bjork', 'bjork')];
    tables.artist_links = [{ id: 'a', artist_id: 'w' }];
    const pair = await onlyPair();
    expect(pair.evidence).toBe('accent-fold');
    expect(pair.blockers).toEqual([]);
  });

  it('does NOT call Boto / Błoto accent-fold', async () => {
    // The discriminating case, and the reason this uses foldToAscii rather than
    // normalizeForComparison: folding maps "Błoto" to "Bloto", which is not "Boto". Under
    // normalizeForComparison both collapse to "boto" and this pair would look mergeable.
    tables.artists = [artist('w', 'Boto', 'boto'), artist('l', 'Błoto', 'b-oto')];
    tables.artist_links = [{ id: 'a', artist_id: 'w' }];
    const pair = await onlyPair();
    expect(pair.evidence).toBe('name-only');
  });

  it('calls a lookalike with no corroboration name-only', async () => {
    tables.artists = [artist('w', 'Honeycrush', 'honeycrush'), artist('l', 'Honey Crush', 'honey-crush')];
    const pair = await onlyPair();
    expect(pair.evidence).toBe('name-only');
  });

  it('blocks a pair whose releases prove they are different artists', async () => {
    // The real Tiger Cub / Tigercub data.
    tables.artists = [artist('w', 'Tigercub', 'tigercub'), artist('l', 'Tiger Cub', 'tiger-cub')];
    tables.releases = [
      { id: 'r1', artist_id: 'w', match_key: 'repressedsemanticsep' },
      { id: 'r2', artist_id: 'l', match_key: 'thesun' },
    ];
    const pair = await onlyPair();
    expect(pair.evidence).toBe('name-only');
    expect(pair.blockers.join(' ')).toContain('share none');
  });

  it('blocks when both rows are claimed', async () => {
    tables.artists = [artist('a', 'Stan Stewart', 'muz4now', 'claimed'),
                      artist('b', 'Stan Stewart', 'stan-stewart', 'claimed')];
    const pair = await onlyPair();
    expect(pair.blockers.join(' ')).toContain('both rows are claimed');
  });

  it('blocks when both rows have a profile', async () => {
    // artist_profiles is UNIQUE(artist_id), so a merge discards one artist's edits outright.
    tables.artists = [artist('w', 'Choan Gálvez', 'choan-g-lvez'), artist('l', 'Choan Galvez', 'choan-galvez')];
    tables.artist_profiles = [{ artist_id: 'w' }, { artist_id: 'l' }];
    const pair = await onlyPair();
    expect(pair.blockers.join(' ')).toContain('artist_profiles');
  });

  it('ignores a three-way name collision rather than guessing a pair', async () => {
    tables.artists = [artist('a', 'Anna', 'anna'), artist('b', 'ANNA', 'anna-2'), artist('c', 'a n n a', 'a-n-n-a')];
    const r = await findDuplicateArtistPairs(client);
    expect(r.ok && r.pairs).toEqual([]);
  });
});

describe('findDuplicateArtistPairs — picking the winner', () => {
  it('prefers the claimed row even when it has fewer links', async () => {
    tables.artists = [artist('claimed', 'Snap Infraction', 'snap-infraction', 'claimed'),
                      artist('rich', 'snapinfraction', 'snapinfraction')];
    tables.artist_links = [
      { id: 'l1', artist_id: 'rich' }, { id: 'l2', artist_id: 'rich' }, { id: 'l3', artist_id: 'rich' },
      { id: 'l4', artist_id: 'claimed' },
    ];
    const pair = await onlyPair();
    // The artist owns that URL and may have shared it.
    expect(pair.winner.id).toBe('claimed');
  });

  it('never lets a machine-key name survive, even on an equal link count', async () => {
    // Both rows have one link, so link count decides nothing and the id tiebreak was picking rows
    // literally named "snapinfractionfeatmadeline" and "controlfreakstudio" as the winner. Found by
    // running the CLI against production, not by the earlier tests.
    tables.artists = [
      artist('aaa', 'snapinfractionfeatmadeline', 'snapinfractionfeatmadeline'),
      artist('zzz', 'Snap Infraction (feat. madeline)', 'snap-infraction-feat-madeline'),
    ];
    tables.artist_links = [{ id: 'l1', artist_id: 'aaa' }, { id: 'l2', artist_id: 'zzz' }];
    const pair = await onlyPair();
    expect(pair.winner.name).toBe('Snap Infraction (feat. madeline)');
    // And the direction matters for classify(), which reads provenance off the *loser*.
    expect(pair.evidence).toBe('provenance');
  });

  it('still lets a claimed row beat a machine-key row', async () => {
    tables.artists = [artist('key', 'kidlightbulbs', 'kidlightbulbs'),
                      artist('real', 'Kid Lightbulbs', 'kid-lightbulbs', 'claimed')];
    const pair = await onlyPair();
    expect(pair.winner.id).toBe('real');
  });

  it('otherwise prefers the row with more links', async () => {
    tables.artists = [artist('thin', 'kidlightbulbs', 'kidlightbulbs'),
                      artist('fat', 'Kid Lightbulbs', 'kid-lightbulbs')];
    tables.artist_links = [{ id: 'a', artist_id: 'fat' }, { id: 'b', artist_id: 'fat' }, { id: 'c', artist_id: 'thin' }];
    const pair = await onlyPair();
    expect(pair.winner.id).toBe('fat');
  });
});

describe('mergeArtistPair — refusals', () => {
  it('refuses a name-only pair', async () => {
    tables.artists = [artist('w', 'Honeycrush', 'honeycrush'), artist('l', 'Honey Crush', 'honey-crush')];
    const result = await mergeArtistPair(client, await onlyPair(), { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.refused).toContain('name similarity');
    expect(tables.artists).toHaveLength(2);
  });

  it('refuses a blocked pair', async () => {
    tables.artists = [artist('a', 'Stan Stewart', 'muz4now', 'claimed'),
                      artist('b', 'Stan Stewart', 'stan-stewart', 'claimed')];
    const result = await mergeArtistPair(client, await onlyPair(), { dryRun: false });
    expect(result.refused).toContain('blocked');
    expect(tables.artists).toHaveLength(2);
  });

  it('proceeds on a blocked pair only with force', async () => {
    tables.artists = [artist('w', 'Choan Gálvez', 'choan-g-lvez'), artist('l', 'Choan Galvez', 'choan-galvez')];
    tables.artist_profiles = [{ artist_id: 'w' }, { artist_id: 'l' }];
    const result = await mergeArtistPair(client, await onlyPair(), { dryRun: false, force: true });
    expect(result.ok).toBe(true);
  });
});

describe('mergeArtistPair — what it writes', () => {
  async function provenancePair() {
    tables.artists = [artist('w', 'Kid Lightbulbs', 'kid-lightbulbs', 'claimed'),
                      artist('l', 'kidlightbulbs', 'kidlightbulbs')];
    return onlyPair();
  }

  it('writes nothing on a dry run, and dry run is the default', async () => {
    const pair = await provenancePair();
    tables.artist_links = [{ id: 'x', artist_id: 'l', platform: 'mirlo' }];

    const result = await mergeArtistPair(client, pair); // no opts at all
    expect(result.dryRun).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(ops.some(o => o.kind !== 'select')).toBe(false);
    expect(tables.artists).toHaveLength(2);
  });

  it('moves only the platforms the winner lacks', async () => {
    const pair = await provenancePair();
    tables.artist_links = [
      { id: 'keep', artist_id: 'w', platform: 'bandcamp' },
      { id: 'dupe', artist_id: 'l', platform: 'bandcamp' },  // winner already has bandcamp
      { id: 'move', artist_id: 'l', platform: 'mirlo' },
    ];
    await mergeArtistPair(client, pair, { dryRun: false });

    expect(tables.artist_links.find(l => l.id === 'move')?.artist_id).toBe('w');
    // The loser's bandcamp row is never reassigned — UNIQUE(artist_id, platform) would reject it.
    // It is left on the loser and Postgres cascades it away with the row (`on delete cascade`);
    // this fake doesn't model cascades, so the assertion is "not moved", not "gone".
    expect(tables.artist_links.find(l => l.id === 'dupe')?.artist_id).toBe('l');
  });

  it('moves only releases the winner does not already have', async () => {
    tables.artists = [artist('w', 'Big Thief', 'big-thief'), artist('l', 'Bigthief', 'bigthief')];
    // The winner has to be pinned by link count — with both rows at zero links the tiebreak is the
    // artist id, which is not what this test is about.
    tables.artist_links = [{ id: 'lk', artist_id: 'w', platform: 'bandcamp' }];
    tables.releases = [
      { id: 'shared-w', artist_id: 'w', match_key: 'dandelion' },
      { id: 'shared-l', artist_id: 'l', match_key: 'dandelion' },
      { id: 'unique-l', artist_id: 'l', match_key: 'vampireempire' },
    ];
    const pair = await onlyPair();
    expect(pair.winner.id).toBe('w');

    await mergeArtistPair(client, pair, { dryRun: false });

    expect(tables.releases.find(r => r.id === 'unique-l')?.artist_id).toBe('w');
    // Reassigning the shared one would duplicate the album on the surviving page. Left on the loser
    // and cascaded away by Postgres, which this fake doesn't model.
    expect(tables.releases.find(r => r.id === 'shared-l')?.artist_id).toBe('l');
  });

  it('moves all analytics so the surviving dashboard keeps both histories', async () => {
    const pair = await provenancePair();
    tables.artist_analytics = [{ id: 'a1', artist_id: 'l' }, { id: 'a2', artist_id: 'l' }];
    await mergeArtistPair(client, pair, { dryRun: false });
    expect(tables.artist_analytics.every(a => a.artist_id === 'w')).toBe(true);
  });

  it('repoints a fan save at the winner by SLUG, not just artist_id', async () => {
    const pair = await provenancePair();
    tables.saved_artists = [{ id: 's1', user_id: 'u1', artist_slug: 'kidlightbulbs', artist_id: 'l' }];
    await mergeArtistPair(client, pair, { dryRun: false });

    // artist_id is ON DELETE SET NULL and there is no FK, so a save survives the delete pointing at
    // a dead slug unless the slug itself is rewritten. That is a silent break for the Mac app.
    expect(tables.saved_artists[0].artist_slug).toBe('kid-lightbulbs');
    expect(tables.saved_artists[0].artist_id).toBe('w');
  });

  it('drops a save that would collide with one the user already has', async () => {
    const pair = await provenancePair();
    tables.saved_artists = [
      { id: 'winner-save', user_id: 'u1', artist_slug: 'kid-lightbulbs', artist_id: 'w' },
      { id: 'loser-save', user_id: 'u1', artist_slug: 'kidlightbulbs', artist_id: 'l' },
    ];
    await mergeArtistPair(client, pair, { dryRun: false });

    // UNIQUE(user_id, artist_slug) would reject the rewrite.
    expect(tables.saved_artists.map(s => s.id)).toEqual(['winner-save']);
  });

  it('reassigns a profile only when the winner has none', async () => {
    const pair = await provenancePair();
    tables.artist_profiles = [{ artist_id: 'l' }];
    await mergeArtistPair(client, pair, { dryRun: false });
    expect(tables.artist_profiles[0].artist_id).toBe('w');
  });

  it('aliases the loser slug BEFORE deleting the row', async () => {
    const pair = await provenancePair();
    await mergeArtistPair(client, pair, { dryRun: false });

    const aliasAt = ops.findIndex(o => o.table === 'artist_slug_aliases' && o.kind === 'upsert');
    const deleteAt = ops.findIndex(o => o.table === 'artists' && o.kind === 'delete');
    expect(aliasAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    // Reversed, the URL 404s for however long the delete-then-alias window lasts — and if the alias
    // write fails, permanently.
    expect(aliasAt).toBeLessThan(deleteAt);
    expect(tables.artist_slug_aliases[0]).toMatchObject({
      alias: 'kidlightbulbs', artist_id: 'w', reason: 'merge',
    });
  });

  it('deletes the loser row last of all', async () => {
    const pair = await provenancePair();
    tables.artist_links = [{ id: 'x', artist_id: 'l', platform: 'mirlo' }];
    tables.artist_analytics = [{ id: 'a', artist_id: 'l' }];
    await mergeArtistPair(client, pair, { dryRun: false });

    const writes = ops.filter(o => o.kind !== 'select');
    expect(writes.at(-1)).toMatchObject({ table: 'artists', kind: 'delete' });
    expect(tables.artists.map(a => a.id)).toEqual(['w']);
  });
});

describe('findReslugCandidates', () => {
  it('re-slugs a mangled accent slug', async () => {
    tables.artists = [artist('a', 'Björk', 'bj-rk')];
    const r = await findReslugCandidates(client);
    expect(r.ok && r.candidates).toEqual([{ id: 'a', name: 'Björk', from: 'bj-rk', to: 'bjork' }]);
  });

  it('never touches a slug an artist chose', async () => {
    // The stored slug is not what any version of artistSlug would produce, so a human set it.
    // Re-slugging these breaks URLs artists share — 11 of the 24 real cases are claimed profiles.
    tables.artists = [
      artist('a', 'Stan Stewart (aka @muz4now)', 'muz4now', 'claimed'),
      artist('b', 'Michael Boezi', 'boezi', 'claimed'),
      artist('c', 'Court Lee', 'courstellation', 'claimed'),
      artist('d', 'MinusOne', 'minus-one'),
    ];
    const r = await findReslugCandidates(client);
    expect(r.ok && r.candidates).toEqual([]);
    expect(r.ok && r.skippedChosen).toBe(4);
  });

  it('leaves rows whose slug already matches', async () => {
    tables.artists = [artist('a', 'Warren Harrison', 'warren-harrison')];
    const r = await findReslugCandidates(client);
    expect(r.ok && r.candidates).toEqual([]);
    expect(r.ok && r.skippedChosen).toBe(0);
  });
});

describe('reslugArtist', () => {
  const candidate = { id: 'a', name: 'Björk', from: 'bj-rk', to: 'bjork' };

  it('refuses while the target slug is held by the duplicate', async () => {
    tables.artists = [artist('a', 'Björk', 'bj-rk'), artist('b', 'Bjork', 'bjork')];
    const r = await reslugArtist(client, candidate, { dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.refused).toContain('merge that pair first');
    expect(tables.artists.find(a => a.id === 'a')?.slug).toBe('bj-rk');
  });

  it('moves the slug and aliases the old one', async () => {
    tables.artists = [artist('a', 'Björk', 'bj-rk')];
    const r = await reslugArtist(client, candidate, { dryRun: false });
    expect(r.ok).toBe(true);
    expect(tables.artists[0].slug).toBe('bjork');
    expect(tables.artist_slug_aliases[0]).toMatchObject({ alias: 'bj-rk', artist_id: 'a', reason: 'reslug' });
  });

  it('follows the slug in saved_artists', async () => {
    tables.artists = [artist('a', 'Björk', 'bj-rk')];
    tables.saved_artists = [{ id: 's', user_id: 'u', artist_slug: 'bj-rk' }];
    await reslugArtist(client, candidate, { dryRun: false });
    expect(tables.saved_artists[0].artist_slug).toBe('bjork');
  });

  it('writes nothing on a dry run', async () => {
    tables.artists = [artist('a', 'Björk', 'bj-rk')];
    const r = await reslugArtist(client, candidate);
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(tables.artists[0].slug).toBe('bj-rk');
    expect(tables.artist_slug_aliases).toEqual([]);
  });
});
