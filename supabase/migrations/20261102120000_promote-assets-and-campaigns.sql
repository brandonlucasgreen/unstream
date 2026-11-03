-- Promote: the asset library and release campaigns (docs/specs/release-autopost-spec.md,
-- "Release campaigns" and "Pictures, and Instagram"). Brandon, 2026-11-02.
--
-- Three server-only tables, like release_autopost_settings: RLS is ENABLED with NO policies,
-- deliberately. The service-role client bypasses RLS and anon gets nothing; every read and write
-- goes through the functions after the feature gate and the verified-claim check. The missing
-- policies are the point, not an oversight.

-- ---------------------------------------------------------------------------------------------
-- promote_assets: images an artist uploads for their posts
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.promote_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,
  -- Who uploaded it: the artist's verified owner at the time.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The object in the media bucket (api/functions/autopost-media.ts), and its public address.
  -- Keyed by the artist and the hash of the bytes, so the same file uploaded twice is one object.
  storage_key TEXT NOT NULL,
  url TEXT NOT NULL,
  -- Images only for now. The library may hold other media later; widen this check then.
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),

  -- Removed by the artist. The row stays until no post already in Buffer still needs the file,
  -- since Buffer fetches an image on the day it publishes; the sweep then deletes the object and
  -- the row (purgeRemovedAssets).
  deleted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.promote_assets IS
  'Images an artist uploaded to the Promote asset library, stored in the media bucket. Server-only: RLS on with no policies.';

ALTER TABLE public.promote_assets ENABLE ROW LEVEL SECURITY;
-- No policies, on purpose. See the header.
REVOKE ALL ON public.promote_assets FROM PUBLIC, anon, authenticated;

-- One live row per file per artist: uploading the same image again is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promote_assets_artist_key
  ON public.promote_assets (artist_id, storage_key) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_promote_assets_artist
  ON public.promote_assets (artist_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- release_campaigns: a planned run of posts for one release
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.release_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  release_id UUID NOT NULL REFERENCES public.releases(id) ON DELETE CASCADE,

  -- The release date the artist confirmed, which {date} in the posts reads. Changing it moves
  -- every post not yet in Buffer by the same number of days.
  release_date DATE NOT NULL,

  -- cancelled: the posts not yet in Buffer were deleted; the ones already there stay there.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.release_campaigns IS
  'Release campaigns: a planned run of posts about one release, on top of release autopost. Server-only: RLS on with no policies.';

ALTER TABLE public.release_campaigns ENABLE ROW LEVEL SECURITY;
-- No policies, on purpose. See the header.
REVOKE ALL ON public.release_campaigns FROM PUBLIC, anon, authenticated;

-- One running campaign per release.
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_campaigns_one_active
  ON public.release_campaigns (release_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_release_campaigns_artist
  ON public.release_campaigns (artist_id, status);

-- ---------------------------------------------------------------------------------------------
-- release_campaign_posts: a campaign's posts, stored ahead (unlike autopost's, which are planned)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.release_campaign_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.release_campaigns(id) ON DELETE CASCADE,
  artist_id UUID NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,

  -- Which step of the timeline it is ('announce', 'release_day', …), or 'custom' for one the
  -- artist added (api/shared/campaign-steps.ts).
  step TEXT NOT NULL,
  -- The artist's local date it posts on.
  post_date DATE NOT NULL,
  -- The words, in the autopost template language ({title}, {link}, …), filled when it's pushed.
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
  -- 'cover', 'photo' or 'upload:{id}', or NULL for no image (Instagram and TikTok then skip it).
  image_key TEXT,

  -- planned: waiting to go to Buffer (72 hours ahead, by the autopost sweep).
  -- pushing: claimed by a run, Buffer being called. A run that dies here leaves it claimed,
  --          which is the safe failure: a missed post rather than a doubled one.
  -- pushed:  in the artist's Buffer. Unstream never edits or deletes it after this.
  -- failed:  Buffer refused or couldn't be reached; retried up to 3 attempts.
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'pushing', 'pushed', 'failed')),
  attempts SMALLINT NOT NULL DEFAULT 0,
  -- When it was scheduled for, set when it's claimed.
  slot_at TIMESTAMPTZ,
  buffer_post_ids JSONB NOT NULL DEFAULT '[]',
  captions JSONB,
  error TEXT,
  pushed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- At most one post a day per campaign.
  UNIQUE (campaign_id, post_date)
);

COMMENT ON TABLE public.release_campaign_posts IS
  'The posts of a release campaign, written ahead and pushed to Buffer by the release autopost sweep. Server-only: RLS on with no policies.';

ALTER TABLE public.release_campaign_posts ENABLE ROW LEVEL SECURITY;
-- No policies, on purpose. See the header.
REVOKE ALL ON public.release_campaign_posts FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_release_campaign_posts_artist_date
  ON public.release_campaign_posts (artist_id, post_date);

-- The sweep's question: which posts are waiting to go to Buffer.
CREATE INDEX IF NOT EXISTS idx_release_campaign_posts_waiting
  ON public.release_campaign_posts (post_date) WHERE status IN ('planned', 'failed');

-- ---------------------------------------------------------------------------------------------
-- save_release_campaign: replace a campaign's unsent posts in one transaction
-- ---------------------------------------------------------------------------------------------

-- Editing a campaign replaces every post not yet sent to Buffer ('planned' or 'failed') with the
-- artist's new list, and sets the release date. Posts already sent ('pushing', 'pushed') are never
-- touched. One function so a failed insert can't leave the campaign with its old posts deleted
-- and no new ones. The caller (release-campaigns-db.ts) has checked ownership and validated every
-- post, including that no new post shares a date with a sent one.
CREATE OR REPLACE FUNCTION public.save_release_campaign(
  p_campaign_id UUID,
  p_release_date DATE,
  p_posts JSONB
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_artist_id UUID;
BEGIN
  UPDATE public.release_campaigns
     SET release_date = p_release_date, updated_at = now()
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
REVOKE EXECUTE ON FUNCTION public.save_release_campaign(UUID, DATE, JSONB) FROM PUBLIC, anon, authenticated;
