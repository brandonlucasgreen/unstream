-- Migration: manual release ordering for claimed artists
--
-- Releases are listed newest first everywhere they appear. A claimed artist may
-- want a different arrangement — lead with the record they're promoting, push a
-- compilation down — exactly as they already arrange their platform links with
-- artist_links.display_order. Same column name, same idea.
--
-- Nullable, and null for every existing row: reads order by
--   display_order ASC NULLS LAST, release_date DESC, created_at DESC
-- so an artist who never touches this keeps today's behaviour precisely, and a
-- release catalogued *after* an artist arranged theirs lands at the end of that
-- arrangement rather than silently displacing what they chose.
--
-- No index. The sort only ever runs over one artist's releases after the
-- artist_id filter — tens of rows, the largest catalogue measured so far is 33 —
-- so idx_releases_artist_id already does the work that matters.
ALTER TABLE releases ADD COLUMN IF NOT EXISTS display_order integer;

COMMENT ON COLUMN releases.display_order IS
  'Position in the artist''s manual release order. NULL means unpositioned; those sort after every positioned release, newest first.';

-- ---------------------------------------------------------------------------
-- Storing an arrangement
-- ---------------------------------------------------------------------------
--
-- One function in one transaction, for the same reason replace_artist_links is
-- one function: a save applied halfway is an arrangement the artist never chose,
-- visible on their public page.
--
-- p_release_ids is the complete arrangement the editor is showing, in order.
-- Ids absent from it are cleared back to unpositioned, which makes an empty
-- array mean "reset to date order" and stops a release catalogued between the
-- editor loading and saving from being handed a position nobody picked.
CREATE OR REPLACE FUNCTION public.set_release_display_order(
  p_artist_id uuid,
  p_release_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE releases
     SET display_order = NULL
   WHERE artist_id = p_artist_id
     AND display_order IS NOT NULL
     AND NOT (id = ANY (COALESCE(p_release_ids, ARRAY[]::uuid[])));

  IF array_length(p_release_ids, 1) > 0 THEN
    UPDATE releases r
       SET display_order = arranged.ord - 1
      FROM unnest(p_release_ids) WITH ORDINALITY AS arranged(release_id, ord)
     WHERE r.artist_id = p_artist_id
       AND r.id = arranged.release_id;
  END IF;
END;
$$;

-- PostgREST publishes every public-schema function as an RPC endpoint, so
-- without this the anon key could rearrange any artist's releases. Only the
-- service-role client may call it — and it does so from artist-releases.ts,
-- which checks ownership of the artist *and* of every release id first.
REVOKE ALL ON FUNCTION public.set_release_display_order(uuid, uuid[]) FROM public;
REVOKE ALL ON FUNCTION public.set_release_display_order(uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.set_release_display_order(uuid, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_release_display_order(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public.set_release_display_order(uuid, uuid[]) IS
  'Stores an artist''s manual release order in one transaction. Releases omitted from the array are reset to unpositioned.';
