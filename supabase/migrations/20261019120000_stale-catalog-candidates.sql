-- Migration: pick the scheduled sweep's batch inside Postgres, in one query.
--
-- `getStaleCatalogCandidates` (api/functions/db.ts) chooses the 25 artists the twice-daily
-- release-catalogue sweep will crawl. Until now it did that in Node: six paged reads through
-- PostgREST — every catalogue-able row of `artist_links`, every undeleted `saved_artists` row,
-- every verified `artist_profiles` row, every `collection_items` row with a slug, those slugs
-- resolved against `artists` in chunks of 100, and the whole of `release_catalog_state` — then
-- Sets and Maps to combine them. The run on 2026-10-18 reported `catalogueable: 5749` with
-- `awaitingDemand: 1347` and `frozenCatalogues: 4213`, so that is well over ten thousand rows
-- serialised to JSON across ~20 round trips, twice a day, to choose 25 ids and eight counters.
--
-- ## Why now, when disk I/O round 1 looked at this and dropped it
--
-- Round 1 (2026-08-11) listed the same selection as item #4 and **dropped it as immaterial**
-- after measuring: ~32 reads a day is nothing against an IOPS budget, and the rule that came out
-- of it — measure before adding an index — was right and still is. This is not a reversal of that
-- finding; the binding constraint moved.
--
-- Round 7 (2026-10-18, docs/specs/supabase-disk-io-investigation.md) measured the instance rather
-- than the queries: ~1.27 GB committed against a ~1.25 GB limit, ~230 MB of cache and ~400 MB in
-- swap, flat across all 24 hours. The overnight unresponsiveness on 09-19, 10-18 and 10-19 is that
-- ceiling, not Unstream's IOPS. Against a memory ceiling the cost of this selection reads
-- differently: six full scans are what evicts a 230 MB buffer cache, and PostgREST materialising
-- ten thousand-plus rows as JSON is memory in the same 0.5 GB. The scans themselves still happen
-- here — this does not make the sweep free — but the rows stop leaving Postgres, the ~20 round
-- trips become one, and the Node-side Sets and Maps disappear.
--
-- **Upgrading the instance remains the actual fix for the outages** (Supabase Pro, see round 7).
-- This reduces load on top of a footprint it cannot shrink.
--
-- ## What the function must preserve
--
-- The selection rules are specified in the doc comment above `getStaleCatalogCandidates` and are
-- reproduced here exactly, including the ones that look like details:
--
--   * **The demand gate** (rounds 5 and 6): an artist gets sweep attention — first catalogue or
--     refresh — only if somebody saved them, a verified claim exists, or a connected Bandcamp
--     collection holds one of their records. Everyone else is counted and left alone.
--   * **A state row with only failed attempts counts as never catalogued**, not as a frozen
--     catalogue: `awaiting_demand` keys off `last_catalogued_at IS NULL`, not off the row
--     existing.
--   * **The cooldown reads `last_catalogued_at`**, not `last_attempted_at`, so a run that failed
--     does not buy a week of silence.
--   * **The `bandcamp.com/search?q=` placeholder is not a catalogue-able link.** This mirrors
--     `isBandcampSearchLink` in search-utils.ts (`url.includes('bandcamp.com/search')`) and must
--     stay identical to the equivalent check in `getArtistForCatalog`, or the sweep spends its
--     batch on artists with nothing to fetch and climbs `consecutive_failures` for them.
--   * **The ordering tiers**: wanted first, then never-attempted, then stalest attempt, then most
--     savers as a tiebreak. The demand gate currently makes every candidate wanted, so the first
--     tier is vacuous today; it stays so that relaxing the gate can never silently deprioritise
--     fans.
--
-- The cooldown length and the platform list are passed in rather than written here:
-- `RECATALOG_COOLDOWN_HOURS` and `CATALOGUEABLE_PLATFORMS` in db.ts stay the single definitions,
-- and a second copy of a constant that must agree is exactly the drift this migration is
-- otherwise trying to avoid. The Bandcamp placeholder rule cannot be parameterised the same way
-- — it is a URL shape, not a list — so that one is written out below and has to be kept in step
-- by hand, the same obligation `isCatalogueableLink` already carries.
--
-- ## Shape
--
-- One row: the eight counters as scalars, and the batch as a jsonb array — the counters describe
-- the whole pool and would be repeated on every candidate row otherwise. Keys are snake_case and
-- mapped in db.ts like every other read there.
--
-- No new table and no RLS change. `artist_links`, `saved_artists`, `artist_profiles`,
-- `collection_items`, `artists` and `release_catalog_state` are all read through the service-role
-- client, which bypasses RLS; the function is SECURITY INVOKER (the default) so it carries no
-- privilege of its own, and EXECUTE is revoked from PUBLIC, anon and authenticated below.

CREATE OR REPLACE FUNCTION public.stale_catalog_candidates(
  p_limit int,
  p_cooldown_hours int,
  p_platforms text[]
)
RETURNS TABLE (
  catalogueable bigint,
  saved_artists bigint,
  claimed_artists bigint,
  collected_artists bigint,
  awaiting_demand bigint,
  frozen_catalogues bigint,
  in_cooldown bigint,
  eligible bigint,
  candidates jsonb
)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  WITH pool AS (
    SELECT DISTINCT l.artist_id
    FROM artist_links l
    WHERE l.artist_id IS NOT NULL
      AND l.platform = ANY(p_platforms)
      -- isCatalogueableLink: the Bandcamp search placeholder is a UI affordance, not a page.
      AND NOT (l.platform = 'bandcamp' AND l.url LIKE '%bandcamp.com/search%')
  ),
  savers AS (
    SELECT s.artist_id, count(*)::int AS savers
    FROM saved_artists s
    WHERE s.deleted = false
      AND s.artist_id IS NOT NULL
    GROUP BY s.artist_id
  ),
  claimed AS (
    -- A verified claim only. A profile row exists from the moment someone opens the claim
    -- wizard, and until verification passes it is a stranger's assertion.
    SELECT DISTINCT p.artist_id
    FROM artist_profiles p
    WHERE p.verified_at IS NOT NULL
      AND p.artist_id IS NOT NULL
  ),
  collected AS (
    SELECT DISTINCT a.id AS artist_id
    FROM collection_items c
    JOIN artists a ON a.slug = c.artist_slug
    WHERE c.artist_slug IS NOT NULL
  ),
  scored AS (
    SELECT
      pool.artist_id,
      (sv.artist_id IS NOT NULL) AS saved,
      (cl.artist_id IS NOT NULL) AS claimed,
      (co.artist_id IS NOT NULL) AS collected,
      COALESCE(sv.savers, 0) AS savers,
      st.last_attempted_at,
      st.last_catalogued_at,
      st.releases_found
    FROM pool
    LEFT JOIN savers sv ON sv.artist_id = pool.artist_id
    LEFT JOIN claimed cl ON cl.artist_id = pool.artist_id
    LEFT JOIN collected co ON co.artist_id = pool.artist_id
    LEFT JOIN release_catalog_state st ON st.artist_id = pool.artist_id
  ),
  classified AS (
    SELECT
      s.*,
      (s.saved OR s.claimed OR s.collected) AS wanted,
      (s.last_catalogued_at IS NOT NULL
        AND s.last_catalogued_at > now() - make_interval(hours => p_cooldown_hours)) AS cooling
    FROM scored s
  ),
  batch AS (
    SELECT c.*
    FROM classified c
    WHERE c.wanted AND NOT c.cooling
    ORDER BY
      c.wanted DESC,
      (c.last_attempted_at IS NOT NULL),  -- false sorts first: never attempted leads
      c.last_attempted_at ASC,
      c.savers DESC
    LIMIT p_limit
  )
  SELECT
    (SELECT count(*) FROM classified),
    (SELECT count(*) FROM classified WHERE saved),
    (SELECT count(*) FROM classified WHERE claimed),
    (SELECT count(*) FROM classified WHERE collected),
    (SELECT count(*) FROM classified WHERE NOT wanted AND last_catalogued_at IS NULL),
    (SELECT count(*) FROM classified WHERE NOT wanted AND last_catalogued_at IS NOT NULL),
    (SELECT count(*) FROM classified WHERE wanted AND cooling),
    (SELECT count(*) FROM classified WHERE wanted AND NOT cooling),
    COALESCE(
      (SELECT jsonb_agg(
         jsonb_build_object(
           'artist_id', b.artist_id,
           'saved', b.saved,
           'claimed', b.claimed,
           'collected', b.collected,
           'savers', b.savers,
           'last_attempted_at', b.last_attempted_at,
           'releases_found', b.releases_found
         )
         ORDER BY
           b.wanted DESC,
           (b.last_attempted_at IS NOT NULL),
           b.last_attempted_at ASC,
           b.savers DESC
       )
       FROM batch b),
      '[]'::jsonb
    );
$function$;

COMMENT ON FUNCTION public.stale_catalog_candidates(int, int, text[]) IS
  'The scheduled release-catalogue sweep''s batch and pool counters, in one query. Demand-gated (saved, verified claim, or in a connected collection) per disk I/O rounds 5 and 6; cooldown length is passed in so RECATALOG_COOLDOWN_HOURS in db.ts stays the single definition. Called only by getStaleCatalogCandidates through the service-role client.';

-- Supabase's default privileges grant EXECUTE on every new public function directly to anon and
-- authenticated, so a PUBLIC revoke alone is not enough — see
-- 20260919140000_revoke-anon-function-execute.sql, where that gap left a row-deleting function
-- anon-callable at /rest/v1/rpc/.
REVOKE EXECUTE ON FUNCTION public.stale_catalog_candidates(int, int, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stale_catalog_candidates(int, int, text[]) TO service_role;
