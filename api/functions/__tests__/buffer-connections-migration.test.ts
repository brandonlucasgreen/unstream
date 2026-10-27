// The buffer_connections migration, executed rather than read.
//
// It carries no Postgres function, so migration-function-grants.test.ts has nothing to say about
// it. What can still go wrong is ordinary and silent: a syntax error, a column that won't hold
// what the code stores, or a lost compare-and-set guard. The guard is the part worth a real
// database — Buffer's refresh tokens are single-use, and two concurrent refreshes spending the
// same one revoke the curator's whole grant, so "only one writer wins" has to be true in SQL,
// not just intended.
//
// Loaded into PGlite (Postgres in WebAssembly, no Docker), as
// recatalog-sweep-selection.test.ts does. Two narrow divergences, same as there:
//   * auth.users is a stand-in, since PGlite has no Supabase auth schema.
//   * The REVOKE line is stripped, because PGlite has no anon/authenticated roles. It is not
//     skipped silently — the text of it is asserted below.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = new URL('../../../supabase/migrations/20261027120000_buffer-connections.sql', import.meta.url);
const sql = readFileSync(MIGRATION, 'utf8');

const db = new PGlite();

beforeAll(async () => {
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
  `);
  // PGlite has no anon/authenticated/service_role roles; the grant line is asserted as text below.
  await db.exec(sql.replace(/^REVOKE .*$/gm, ''));
});

afterAll(async () => { await db.close(); });

const newUser = async () => {
  const { rows } = await db.query<{ id: string }>('INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id');
  return rows[0].id;
};

const connect = async (userId: string) =>
  db.query(
    `INSERT INTO buffer_connections (user_id, access_token_encrypted, refresh_token_encrypted, expires_at, organization_id)
     VALUES ($1, 'cipher-access', 'cipher-refresh', now() + interval '1 hour', 'org_1')`,
    [userId],
  );

describe('the migration runs', () => {
  it('creates the table with the columns the code writes', async () => {
    const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'buffer_connections' ORDER BY column_name`,
    );
    expect(rows.map(r => r.column_name)).toEqual([
      'access_token_encrypted', 'created_at', 'expires_at', 'organization_id',
      'refresh_counter', 'refresh_token_encrypted', 'selected_channel_ids', 'updated_at', 'user_id',
    ]);
  });

  it('is re-runnable, as every migration here has to be', async () => {
    await expect(db.exec(sql.replace(/^REVOKE .*$/gm, ''))).resolves.toBeDefined();
  });

  it('enables row-level security', async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'buffer_connections'`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
  });

  // Server-only: RLS on with NO policies means the service role reaches it and nobody else does.
  // A policy appearing here later would quietly open the tokens to any signed-in session.
  it('carries no policies, which is the point', async () => {
    const { rows } = await db.query(`SELECT policyname FROM pg_policies WHERE tablename = 'buffer_connections'`);
    expect(rows).toEqual([]);
  });

  // PGlite can't hold the roles, so this half is checked as text. Without it, anon and
  // authenticated keep Supabase's default grants and could read the tokens through PostgREST.
  it('revokes the default grants Supabase hands anon and authenticated', () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.buffer_connections FROM PUBLIC, anon, authenticated/);
  });
});

describe('one connection per user', () => {
  it('holds exactly one row per user', async () => {
    const user = await newUser();
    await connect(user);
    await expect(connect(user)).rejects.toThrow();
  });

  it('goes when the user goes', async () => {
    const user = await newUser();
    await connect(user);
    await db.query('DELETE FROM auth.users WHERE id = $1', [user]);
    const { rows } = await db.query('SELECT 1 FROM buffer_connections WHERE user_id = $1', [user]);
    expect(rows).toEqual([]);
  });

  it('defaults to no chosen channels rather than null', async () => {
    const user = await newUser();
    await connect(user);
    const { rows } = await db.query<{ selected_channel_ids: string[]; refresh_counter: string }>(
      'SELECT selected_channel_ids, refresh_counter FROM buffer_connections WHERE user_id = $1', [user],
    );
    expect(rows[0].selected_channel_ids).toEqual([]);
    expect(Number(rows[0].refresh_counter)).toBe(0);
  });
});

describe('the single-use refresh guard', () => {
  // The hazard in one test: two requests refresh at once, both read counter 0, both try to
  // spend the same refresh token. Buffer would revoke the grant. Only one update may win.
  it('lets exactly one of two concurrent refreshes win', async () => {
    const user = await newUser();
    await connect(user);

    const spend = (seenCounter: number) => db.query<{ user_id: string }>(
      `UPDATE buffer_connections
          SET access_token_encrypted = 'new-access',
              refresh_token_encrypted = 'new-refresh',
              refresh_counter = refresh_counter + 1,
              updated_at = now()
        WHERE user_id = $1 AND refresh_counter = $2
      RETURNING user_id`,
      [user, seenCounter],
    );

    const first = await spend(0);
    const second = await spend(0);          // the loser, holding the same stale counter

    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);    // affected nothing: it must re-read, not call Buffer

    const { rows } = await db.query<{ refresh_counter: string; refresh_token_encrypted: string }>(
      'SELECT refresh_counter, refresh_token_encrypted FROM buffer_connections WHERE user_id = $1', [user],
    );
    expect(Number(rows[0].refresh_counter)).toBe(1);
    expect(rows[0].refresh_token_encrypted).toBe('new-refresh');
  });
});
