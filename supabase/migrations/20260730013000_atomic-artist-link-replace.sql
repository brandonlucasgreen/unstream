-- Migration: replace an artist's links atomically
--
-- Saving a claimed artist's links used to be three separate requests from
-- api/functions/artist-profile.ts: delete every artist_links row, update
-- artist_profiles.link_dividers, then insert the new rows. Any failure after
-- the delete left the artist with ZERO links and no way to get them back.
--
-- That is not hypothetical. On 2026-07-29 the link_dividers write ran against a
-- database that did not have the column yet (the deploy preview for the divider
-- feature was live ~8 minutes before the migration applied). PostgREST returned
-- PGRST204, the handler returned 500, and the insert never ran — a verified
-- artist lost all 13 of their links and they had to be recovered from an
-- internet-archive snapshot.
--
-- One function in one transaction makes that failure mode impossible: either the
-- artist's new arrangement is stored or their old one is left untouched.
--
-- Note the delete is deliberately NOT scoped to source = 'claimed'. A claimed
-- artist's editor list is the complete intended contents of their page, so
-- enrichment-sourced rows are replaced too. That matches the previous behavior;
-- scoping it would resurface links the artist had removed.
CREATE OR REPLACE FUNCTION public.replace_artist_links(
  p_artist_id uuid,
  p_links jsonb,
  p_dividers integer[]
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM artist_links WHERE artist_id = p_artist_id;

  IF p_links IS NOT NULL AND jsonb_array_length(p_links) > 0 THEN
    INSERT INTO artist_links (
      artist_id, platform, url, display_name, source, is_direct, display_order
    )
    SELECT
      p_artist_id,
      entry->>'platform',
      entry->>'url',
      NULLIF(entry->>'display_name', ''),
      'claimed',
      true,
      (entry->>'display_order')::integer
    FROM jsonb_array_elements(p_links) AS entry;
  END IF;

  UPDATE artist_profiles
     SET link_dividers = CASE
           WHEN array_length(p_dividers, 1) > 0 THEN p_dividers
           ELSE NULL
         END,
         updated_at = now()
   WHERE artist_id = p_artist_id;
END;
$$;

-- PostgREST publishes every function in the public schema as an RPC endpoint,
-- so without this the anon key could wipe any artist's links. Only the
-- service-role client (used by the authenticated artist-profile function, which
-- checks ownership first) may call it.
REVOKE ALL ON FUNCTION public.replace_artist_links(uuid, jsonb, integer[]) FROM public;
REVOKE ALL ON FUNCTION public.replace_artist_links(uuid, jsonb, integer[]) FROM anon;
REVOKE ALL ON FUNCTION public.replace_artist_links(uuid, jsonb, integer[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_artist_links(uuid, jsonb, integer[]) TO service_role;

COMMENT ON FUNCTION public.replace_artist_links(uuid, jsonb, integer[]) IS
  'Replaces all of an artist''s links and their divider positions in one transaction, so a mid-save failure cannot leave the artist with zero links.';
