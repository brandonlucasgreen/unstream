-- Artist patronage, phase 1: "I'd tip them" and Play my city (docs/specs/artist-patronage-spec.md
-- §3.5, §3.6, §9).
--
-- No money is involved. Each table records one row per signed-in fan per artist:
--   tip_interest   a fan would tip this artist if they could (the artist isn't taking tips yet)
--   city_interest  the city a fan would come to a show in
--
-- Counts are shown publicly only at three or more (the threshold lives in the callers and is
-- passed to get_artist_interest_counts as p_min), so a count can't point at one person in a
-- small town. The artist's own dashboard asks for p_min = 1.
--
-- The primary keys lead with artist_id, not user_id: every count is "for this artist", and the
-- PK index serves it. The fan-side read ("which artists have I tapped?") filters on user_id alone
-- and scans; both tables are one small row per tap, and the spec asks for no indexes beyond the
-- primary keys, so that trade is deliberate. Add (user_id) if a fan's list ever gets slow.
--
-- ON DELETE CASCADE on artist_id is the fallback only: an artist merge repoints these rows onto
-- the surviving artist first (artist-merge.ts), so a merge doesn't lose anyone's tap.

CREATE TABLE IF NOT EXISTS tip_interest (
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artist_id, user_id)
);

CREATE TABLE IF NOT EXISTS city_interest (
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Lowercased, trimmed, whitespace-collapsed free text (cityKey() in api/shared/city-key.ts).
  -- It is the grouping key; city_label is what the fan typed, for display.
  city_key text NOT NULL CHECK (char_length(city_key) BETWEEN 1 AND 100),
  city_label text NOT NULL CHECK (char_length(city_label) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artist_id, user_id)
);

DROP TRIGGER IF EXISTS city_interest_updated_at ON city_interest;
CREATE TRIGGER city_interest_updated_at
  BEFORE UPDATE ON city_interest
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Server-only, deliberately: RLS on with no policies. The service-role client (getClient() in
-- db.ts) is the only reader or writer, and every read that reaches a client goes through
-- api/functions/artist-interest.ts or the artist page payload, which apply the threshold. A policy
-- letting anon read these tables would expose which user tapped which artist.
ALTER TABLE tip_interest ENABLE ROW LEVEL SECURITY;
ALTER TABLE city_interest ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE tip_interest IS
  '"I''d tip them": one row per fan per artist not yet taking tips. No amount, ever. Server-only; no RLS policies by design.';
COMMENT ON TABLE city_interest IS
  'Play my city: one city per fan per artist. Server-only; no RLS policies by design.';

-- Counts for a batch of artists, by slug: the artist page asks for one, a search for up to a
-- page of results. Only artists with at least one row of either kind come back.
--
-- p_min is the display threshold, applied here so the public callers can't forget it: a tip
-- count below it reads as 0 and a city below it is left out. p_limit caps the city list.
-- The city label shown is the most common spelling fans typed for that key.
CREATE OR REPLACE FUNCTION public.get_artist_interest_counts(p_slugs text[], p_min integer, p_limit integer)
RETURNS TABLE(slug text, tip_count integer, cities jsonb)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT
    a.slug,
    (SELECT CASE WHEN count(*) >= p_min THEN count(*)::integer ELSE 0 END
       FROM tip_interest t WHERE t.artist_id = a.id) AS tip_count,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('label', c.label, 'count', c.n) ORDER BY c.n DESC, c.label)
      FROM (
        SELECT mode() WITHIN GROUP (ORDER BY ci.city_label) AS label, count(*)::integer AS n
        FROM city_interest ci
        WHERE ci.artist_id = a.id
        GROUP BY ci.city_key
        HAVING count(*) >= p_min
        ORDER BY count(*) DESC, ci.city_key
        LIMIT p_limit
      ) c
    ), '[]'::jsonb) AS cities
  FROM artists a
  WHERE a.slug = ANY(p_slugs)
    AND (EXISTS (SELECT 1 FROM tip_interest t WHERE t.artist_id = a.id)
      OR EXISTS (SELECT 1 FROM city_interest ci WHERE ci.artist_id = a.id));
$function$;

-- Suggestions for the Play my city input, so "Boston" and "boston, ma" converge on one key.
-- Only cities at least three fans have named (across all artists) are suggested — a suggestion
-- list is public, and a city one person typed would reveal that they did.
CREATE OR REPLACE FUNCTION public.get_city_suggestions(p_prefix text, p_limit integer)
RETURNS TABLE(city_label text)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT mode() WITHIN GROUP (ORDER BY ci.city_label)
  FROM city_interest ci
  WHERE left(ci.city_key, char_length(p_prefix)) = p_prefix
  GROUP BY ci.city_key
  HAVING count(DISTINCT ci.user_id) >= 3
  ORDER BY count(DISTINCT ci.user_id) DESC, ci.city_key
  LIMIT p_limit;
$function$;

-- CLAUDE.md, security practices: Supabase grants EXECUTE on new public functions directly to
-- anon and authenticated, so revoke from all three and rely on the service role.
REVOKE EXECUTE ON FUNCTION public.get_artist_interest_counts(text[], integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_artist_interest_counts(text[], integer, integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_city_suggestions(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_city_suggestions(text, integer) TO service_role;
