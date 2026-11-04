// The campaign-channels migration, executed rather than read
// (supabase/migrations/20261103120000_campaign-channels.sql).
//
// Two things in it are the kind that fail silently in production. The backfill is a one-shot data
// change — campaigns already running kept posting to autopost's channels, so that is what they
// must end up holding, and nobody would notice an empty array until a launch posted nowhere. And
// `save_release_campaign` gains an argument: CREATE OR REPLACE with a new argument list *adds an
// overload* rather than replacing, which would leave the three-argument version callable and a
// campaign's channels silently unwritten. Both are checked here against a real Postgres.
//
// Loaded into PGlite (Postgres in WebAssembly, no Docker), as buffer-connections-migration.test.ts
// does, with the same two divergences: auth.users is a stand-in, since PGlite has no Supabase auth
// schema, and the REVOKE lines are stripped because PGlite has no anon/authenticated roles —
// migration-function-grants.test.ts is what checks those are present.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const withoutRevokes = (sql: string) => sql.replace(/^REVOKE .*$/gm, '');

const db = new PGlite();

const ARTIST = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const RELEASE = '33333333-3333-3333-3333-333333333333';
const RELEASE_2 = '44444444-4444-4444-4444-444444444444';
const USER = '55555555-5555-5555-5555-555555555555';

beforeAll(async () => {
  // The tables the migrations point at, as far as they are pointed at.
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.artists (id uuid PRIMARY KEY);
    CREATE TABLE public.releases (id uuid PRIMARY KEY);
    CREATE TABLE public.release_autopost_settings (artist_id uuid PRIMARY KEY, channel_ids TEXT[] NOT NULL DEFAULT '{}');
    INSERT INTO auth.users (id) VALUES ('${USER}');
    INSERT INTO public.artists (id) VALUES ('${ARTIST}'), ('${OTHER}');
    INSERT INTO public.releases (id) VALUES ('${RELEASE}'), ('${RELEASE_2}');
    INSERT INTO public.release_autopost_settings (artist_id, channel_ids) VALUES ('${ARTIST}', ARRAY['bsky', 'ig']);
  `);
  await db.exec(withoutRevokes(read('20261102120000_promote-assets-and-campaigns.sql')));

  // Two campaigns from before the change: one artist ticks channels for autopost, one doesn't.
  await db.exec(`
    INSERT INTO public.release_campaigns (id, artist_id, user_id, release_id, release_date)
    VALUES ('66666666-6666-6666-6666-666666666666', '${ARTIST}', '${USER}', '${RELEASE}', '2026-12-04'),
           ('77777777-7777-7777-7777-777777777777', '${OTHER}', '${USER}', '${RELEASE_2}', '2026-12-04');
  `);

  await db.exec(withoutRevokes(read('20261103120000_campaign-channels.sql')));
});

afterAll(async () => { await db.close(); });

const channelsOf = async (id: string) => {
  const { rows } = await db.query<{ channel_ids: string[] }>('SELECT channel_ids FROM release_campaigns WHERE id = $1', [id]);
  return rows[0].channel_ids;
};

describe('the campaign-channels migration', () => {
  it('gives a running campaign the channels it was already posting to', async () => {
    expect(await channelsOf('66666666-6666-6666-6666-666666666666')).toEqual(['bsky', 'ig']);
  });

  it('leaves a campaign whose artist ticked none empty rather than guessing', async () => {
    expect(await channelsOf('77777777-7777-7777-7777-777777777777')).toEqual([]);
  });

  it('replaces save_release_campaign rather than adding an overload', async () => {
    const { rows } = await db.query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'save_release_campaign'`,
    );
    expect(rows.map(r => r.args)).toEqual(['p_campaign_id uuid, p_release_date date, p_channel_ids text[], p_posts jsonb']);
  });

  it('writes the channels with the posts, and leaves sent posts alone', async () => {
    const campaign = '66666666-6666-6666-6666-666666666666';
    await db.query(
      `INSERT INTO release_campaign_posts (campaign_id, artist_id, step, post_date, text, status)
       VALUES ($1, $2, 'announce', '2026-11-06', 'already gone', 'pushed')`,
      [campaign, ARTIST],
    );
    await db.query('SELECT save_release_campaign($1, $2, $3, $4)', [
      campaign,
      '2026-12-11',
      ['th'],
      JSON.stringify([{ step: 'release_day', post_date: '2026-12-11', text: 'out now', image_key: 'cover' }]),
    ]);

    expect(await channelsOf(campaign)).toEqual(['th']);
    const { rows } = await db.query<{ text: string; status: string }>(
      'SELECT text, status FROM release_campaign_posts WHERE campaign_id = $1 ORDER BY post_date',
      [campaign],
    );
    expect(rows).toEqual([
      { text: 'already gone', status: 'pushed' },
      { text: 'out now', status: 'planned' },
    ]);
  });
});
