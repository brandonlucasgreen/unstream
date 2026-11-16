// The one Supabase client, and the paging helper for reads that can exceed 1,000 rows.
//
// Every module in this folder takes getClient from here, so there is exactly one client instance.
// Modules in this folder import each other directly ('./client'), never through '../db': tests
// mock that path, and a module importing through it would be handed the mock.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | null = null;

export function getClient(): SupabaseClient | null {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    return null;
  }

  supabase = createClient(url, key);
  return supabase;
}

/**
 * Read a whole table through PostgREST, a page at a time.
 *
 * **`.limit(n)` does not do this.** PostgREST caps every response at its configured `max-rows`
 * (1,000 on this project) regardless of the limit asked for, and it truncates *silently* — the
 * rows simply aren't there. A single `.select()` over `artist_links` returns 1,000 of ~3,900
 * rows and looks perfectly successful, which would quietly hide three quarters of the sweep's
 * pool. Measured on production 2026-08-02.
 *
 * Exported because the cap is not the sweep's problem, it's every read's problem: use this for
 * any query whose table can exceed 1,000 rows, and pass the caller's own `.range(from, to)`.
 */
export async function readAllPages<T>(
  run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string
): Promise<{ ok: true; rows: T[] } | { ok: false; reason: string }> {
  const PAGE = 1_000;
  /** A backstop against an unbounded loop, not an expected ceiling. */
  const MAX_PAGES = 50;
  const rows: T[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) {
      console.error(`[DB] ${label} read failed:`, error.message);
      return { ok: false, reason: `Could not read ${label}: ${error.message}` };
    }
    const batch = (data as T[]) ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return { ok: true, rows };
  }

  // Hitting this means the table outgrew the backstop. Say so rather than returning a truncated
  // pool that reads as complete — the whole point of this helper.
  console.error(`[DB] ${label} exceeded ${MAX_PAGES * PAGE} rows; refusing a truncated read`);
  return { ok: false, reason: `${label} is larger than this read can page through` };
}
