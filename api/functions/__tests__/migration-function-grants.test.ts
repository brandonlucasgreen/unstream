// Every migration that creates a Postgres function must revoke EXECUTE on it.
//
// Supabase sets default privileges that grant EXECUTE on each new `public` function **directly**
// to `anon` and `authenticated`, so `REVOKE ... FROM PUBLIC` alone leaves both able to call it at
// `/rest/v1/rpc/<name>`. That gap left `rollup_app_events()` — which deletes rows — anon-callable
// in production for a few hours on 2026-09-19, and the cleanup migration
// (20260919140000_revoke-anon-function-execute.sql) spells out why it cannot be fixed once and
// for all: `ALTER DEFAULT PRIVILEGES` cannot revoke the built-in PUBLIC grant, so **every**
// migration that creates a function has to carry its own revoke. CLAUDE.md states the rule.
//
// This is a text check on purpose. The class is unreachable from a throwaway Postgres — vanilla
// Postgres has no such default privileges, so a Docker or PGlite harness passes while production
// is still open — which is exactly why the one thing that can be checked here, that the statement
// is present at all, is worth checking automatically rather than by eye in review.
//
// Scope starts after the cleanup migration: everything before it is covered by that migration's
// own loop over `pg_proc`, and some of it predates the rule.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

/** The migration that closed the historical gap. Files at or before it are its own business. */
const CLEANUP = '20260919140000';

const CREATE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
const REVOKE =
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\([^)]*\)\s*FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/gi;

const files = readdirSync(MIGRATIONS)
  .filter(name => name.endsWith('.sql') && name.slice(0, 14) > CLEANUP)
  .map(name => ({ name, sql: readFileSync(MIGRATIONS + name, 'utf8') }))
  .filter(file => [...file.sql.matchAll(CREATE)].length > 0);

describe('migrations that create functions', () => {
  // A guard that silently matched nothing would be worse than no guard: it would read as
  // "checked" in CI forever.
  it('finds migrations to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map(f => f.name))('%s revokes EXECUTE from PUBLIC, anon and authenticated', name => {
    const sql = files.find(f => f.name === name)!.sql;
    const created = new Set([...sql.matchAll(CREATE)].map(m => m[1].toLowerCase()));
    const revoked = new Set([...sql.matchAll(REVOKE)].map(m => m[1].toLowerCase()));

    expect([...created].filter(fn => !revoked.has(fn))).toEqual([]);
  });
});
