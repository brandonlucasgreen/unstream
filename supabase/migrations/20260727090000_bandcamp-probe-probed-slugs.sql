-- Bandcamp probe cache: record which slug candidates were actually tried.
--
-- Fixes a cache collision. `query_norm` is normalizeForComparison(query), which
-- strips punctuation -- but punctuation is exactly what generates the extra slug
-- candidate in bandcampSlugCandidates:
--
--   "Morice"   -> query_norm 'morice' -> candidates ['morice']
--   "Mo-Rice"  -> query_norm 'morice' -> candidates ['morice', 'mo-rice']
--
-- Both spellings share one row. A search for the misspelling probes only
-- 'morice' (a 404), writes verdict 'absent', and every later search for the
-- correct "Mo-Rice" reads that row and returns nothing -- without ever trying
-- mo-rice.bandcamp.com, which is a live account with 16 releases.
--
-- Negatives already expire after 30 days, so this was never permanent. But any
-- repeated search for the wrong spelling refreshes the row, which kept it alive
-- indefinitely in practice: an integration-test fixture querying "Morice" was
-- doing exactly that.
--
-- With the tried candidates recorded, a cached negative is only reused when it
-- covers every candidate the current query would probe. Existing rows have NULL
-- here, so their negatives are re-probed once and then self-heal.

ALTER TABLE public.bandcamp_slug_probes
  ADD COLUMN IF NOT EXISTS probed_slugs TEXT[];

COMMENT ON COLUMN public.bandcamp_slug_probes.probed_slugs IS
  'Slug candidates actually attempted during this probe round. A cached negative is only reused when it covers every candidate the current query would try; NULL means unknown (legacy row), so negatives are re-probed once.';
