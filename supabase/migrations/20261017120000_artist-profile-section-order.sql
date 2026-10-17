-- Page section order for claimed artist profiles (UNS-221).
--
-- The artist page previously hardcoded its layout: Tip → bio → featured release →
-- "Support directly" (every non-social link) → "Follow" (social links). Claimed artists could
-- order the links themselves but not the sections around them. `section_order` is an ordered
-- list of section keys — a subset of the sections that can appear, minus "tip", which is
-- always first inside Patronage and never artist-ordered (see api/shared/page-sections.ts).
--
-- NULL means "no arrangement saved": the renderer falls back to the default order
-- (bio, featured, patronage, marketplaces, social — see api/shared/page-sections.ts). Unknown
-- keys in the array are ignored at read time, so removing a section later cannot strand a
-- stored order. Idempotent, safe to re-run.
ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS section_order text[];

COMMENT ON COLUMN artist_profiles.section_order IS
  'Artist-arranged order of artist-page sections (UNS-221). Array of section keys: bio, featured, marketplaces, social — patronage is fixed first (tips render at the top of it). NULL = default order. Unknown keys ignored.';