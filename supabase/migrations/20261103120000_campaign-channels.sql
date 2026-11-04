-- Release campaigns choose their own social channels (docs/specs/release-autopost-spec.md,
-- "Release campaigns"). Brandon, 2026-11-03.
--
-- Until now a campaign posted wherever autopost posted: release_autopost_settings.channel_ids was
-- the only list of channels. They are separate features — a launch may want Instagram and TikTok
-- where the weekly rhythm only wants Bluesky — so each campaign now carries its own channels, and
-- the Campaigns tab picks them. What stays shared is the Buffer connection itself: which Buffer
-- login, which organization, which timezone and posting time, all still on the settings row.

ALTER TABLE public.release_campaigns
  ADD COLUMN IF NOT EXISTS channel_ids TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.release_campaigns.channel_ids IS
  'Buffer channel ids this campaign posts to, inside the artist''s organization (release_autopost_settings.organization_id). Separate from autopost''s channel_ids.';

-- Campaigns that already exist kept posting to autopost's channels, so that is what they keep.
-- A campaign left with none is not posted: the sweep reports it rather than guessing.
UPDATE public.release_campaigns c
   SET channel_ids = s.channel_ids
  FROM public.release_autopost_settings s
 WHERE s.artist_id = c.artist_id
   AND c.status = 'active'
   AND cardinality(c.channel_ids) = 0
   AND cardinality(s.channel_ids) > 0;

-- ---------------------------------------------------------------------------------------------
-- save_release_campaign: now also sets the campaign's channels
-- ---------------------------------------------------------------------------------------------

-- CREATE OR REPLACE with a new argument list would add an overload rather than replace the
-- function, leaving the three-argument version callable, so the old one is dropped first.
DROP FUNCTION IF EXISTS public.save_release_campaign(UUID, DATE, JSONB);

-- Editing a campaign replaces every post not yet sent to Buffer ('planned' or 'failed') with the
-- artist's new list, and sets the release date and the channels. Posts already sent ('pushing',
-- 'pushed') are never touched, and neither are the channels they went to: those posts are in
-- Buffer already. One function so a failed insert can't leave the campaign with its old posts
-- deleted and no new ones. The caller (release-campaigns-db.ts) has checked ownership and
-- validated every post and every channel.
CREATE OR REPLACE FUNCTION public.save_release_campaign(
  p_campaign_id UUID,
  p_release_date DATE,
  p_channel_ids TEXT[],
  p_posts JSONB
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_artist_id UUID;
BEGIN
  UPDATE public.release_campaigns
     SET release_date = p_release_date, channel_ids = p_channel_ids, updated_at = now()
   WHERE id = p_campaign_id AND status = 'active'
  RETURNING artist_id INTO v_artist_id;
  IF v_artist_id IS NULL THEN
    RAISE EXCEPTION 'campaign % is not active', p_campaign_id;
  END IF;

  DELETE FROM public.release_campaign_posts
   WHERE campaign_id = p_campaign_id AND status IN ('planned', 'failed');

  INSERT INTO public.release_campaign_posts (campaign_id, artist_id, step, post_date, text, image_key)
  SELECT p_campaign_id, v_artist_id, p.step, p.post_date, p.text, p.image_key
    FROM jsonb_to_recordset(p_posts) AS p(step TEXT, post_date DATE, text TEXT, image_key TEXT);
END;
$$;

-- Server only. Supabase grants EXECUTE on new public functions to anon and authenticated
-- directly, so revoking from PUBLIC alone isn't enough (CLAUDE.md, "Security practices").
REVOKE EXECUTE ON FUNCTION public.save_release_campaign(UUID, DATE, TEXT[], JSONB) FROM PUBLIC, anon, authenticated;
