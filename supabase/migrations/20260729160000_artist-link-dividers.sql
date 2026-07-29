-- Migration: link dividers on claimed artist profiles
--
-- Claimed artists can group the links on their artist page by dropping
-- horizontal dividers between them. A divider is a position in the artist's
-- link order, not a link: storing it as a row in artist_links would mean every
-- reader of that table (search results, the public API, the Apple app) had to
-- know to filter it out, and a divider row would need a fake URL to satisfy
-- `url text not null`.
--
-- Each element is "the number of links before this divider" in the artist's
-- full ordered link list — the same ordering artist_links.display_order
-- expresses. 0 (leading) and >= link count (trailing) are dropped on write and
-- ignored on read; see api/shared/link-dividers.ts.
ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS link_dividers integer[];

COMMENT ON COLUMN artist_profiles.link_dividers IS
  'Positions of horizontal dividers in the artist''s link list, counted as the number of preceding links.';
