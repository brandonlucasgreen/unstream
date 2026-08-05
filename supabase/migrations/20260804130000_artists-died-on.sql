-- Migration: record an artist's date of death on the artist row, and set the 56 we can prove
--
-- "Artists You Know" tells visitors that these artists "have music available for direct
-- purchase", and the weekly social posts say things like "support them directly". Both were
-- being generated for artists who have died: 107 of the 957 verified rows, five of whom had
-- already gone out in a published post (Sara Tavares, Dusty Hill, Brook Benton, Lhasa de Sela,
-- Lex Barker — see data/social-posts/history.json).
--
-- Their /artist/ pages are staying. They are accurate and useful — an estate really does sell
-- Elliott Smith, MF DOOM and John Prine on Bandcamp, and pointing a fan there is the whole
-- purpose of the site. What has to change is the copy that surrounds them, so this column exists
-- to let the index and the post generator leave a deceased artist out while the page stays.
--
-- Nullable and unset by default, and NULL means "no death date recorded" — NOT "alive". The
-- distinction matters because only dates that can be proved are written: an artist whose own
-- MusicBrainz ID resolves to a Wikidata entity with P570 (date of death). Name-only matches are
-- deliberately excluded, because matching "Sebastian Bach" against Johann Sebastian Bach and
-- "Jack White" against a footballer is exactly what that approach does — both happened while
-- this was being researched. Treating an absent date as proof of life would be the same mistake
-- as caching a failed lookup as a negative result.
--
-- A date, not a boolean, because the date is the evidence. A bare flag would be unauditable, and
-- a wrong one unfalsifiable.
--
-- The 56 dates below are seeded here rather than left to scripts/backfill-artist-death-dates.ts,
-- so the filters that read this column start working the moment the migration applies instead of
-- waiting on someone to remember a manual step. Run that script to pick up later deaths; it
-- resolves the same way and only writes what changed.
--
-- A further ~50 artists in the set are probably dead but matched only by name, so they are NOT
-- written here. They need per-name confirmation first.

ALTER TABLE public.artists
  ADD COLUMN IF NOT EXISTS died_on date;

COMMENT ON COLUMN public.artists.died_on IS
  'Date of death, from Wikidata P570 via the artist''s MusicBrainz ID. NULL means no death date '
  'is recorded, not that the artist is alive. Set it only from evidence tied to the artist''s own '
  'identifier, never from a name match.';

-- Partial index: every consumer asks for the living set, so the useful index is the one over
-- rows with no date. Small table, but this is the read on the /known-artists path.
CREATE INDEX IF NOT EXISTS idx_artists_living
  ON public.artists (match_confidence)
  WHERE died_on IS NULL;

-- Seed the proved dates. Matched by slug, and only where died_on is still unset, so re-running
-- changes nothing and never overwrites a correction made later by hand.
UPDATE public.artists AS a
   SET died_on = d.died_on::date
  FROM (VALUES
  ('ace-frehley', '2025-10-16'),
  ('alex-chilton', '2010-03-17'),
  ('andrew-wood', '1990-03-19'),
  ('benny-golson', '2024-09-21'),
  ('bert-jansch', '2011-10-05'),
  ('betty-davis', '2022-02-09'),
  ('brook-benton', '1988-04-09'),
  ('chip-taylor', '2026-03-23'),
  ('chuck-mangione', '2025-07-22'),
  ('conway-twitty', '1993-06-05'),
  ('dan-hartman', '1994-03-22'),
  ('daniel-johnston', '2019-09-10'),
  ('del-shannon', '1990-02-08'),
  ('dennis-brown', '1999-07-01'),
  ('doc-watson', '2012-05-29'),
  ('dusty-hill', '2021-07-27'),
  ('eddie-clarke', '2018-01-10'),
  ('elizabeth-cotten', '1987-06-29'),
  ('elza-soares', '2022-01-20'),
  ('gilda', '1996-09-07'),
  ('gregory-isaacs', '2010-10-25'),
  ('gustavo-cerati', '2014-09-04'),
  ('hector-lavoe', '1993-06-29'),
  ('hubert-sumlin', '2011-12-04'),
  ('ian-mcdonald', '2022-02-09'),
  ('ian-stewart', '1985-12-12'),
  ('jack-dejohnette', '2025-10-26'),
  ('jack-teagarden', '1964-01-15'),
  ('james-cotton', '2017-03-16'),
  ('jimmy-reed', '1976-08-29'),
  ('joe-henderson', '2001-06-30'),
  ('john-prine', '2020-04-07'),
  ('kirka', '2007-01-31'),
  ('klaus-schulze', '2022-04-26'),
  ('koko-taylor', '2009-06-03'),
  ('link-wray', '2005-11-05'),
  ('little-walter', '1968-02-15'),
  ('max-romeo', '2025-04-11'),
  ('mike-bloomfield', '1981-02-15'),
  ('paul-di-anno', '2024-10-21'),
  ('peter-brotzmann', '2023-06-22'),
  ('pierre-schaeffer', '1995-08-19'),
  ('r-l-burnside', '2005-09-01'),
  ('roy-ayers', '2025-03-04'),
  ('roy-buchanan', '1988-08-14'),
  ('roy-haynes', '2024-11-12'),
  ('sara-tavares', '2023-11-19'),
  ('skip-james', '1969-10-03'),
  ('sly-stone', '2025-06-09'),
  ('teresa-brewer', '2007-10-17'),
  ('tiny-tim', '1996-11-30'),
  ('tony-allen', '2020-04-30'),
  ('tony-joe-white', '2018-10-24'),
  ('tyagaraja', '1847-01-06'),
  ('willie-colon', '2026-02-21'),
  ('woody-herman', '1987-10-29')
  ) AS d(slug, died_on)
 WHERE a.slug = d.slug
   AND a.died_on IS NULL;

-- RLS: `artists` already has public SELECT and service-role INSERT/UPDATE policies from the
-- baseline migration, and a new column inherits them. Nothing to add — a visitor can read
-- died_on, and only the service role can set it.
