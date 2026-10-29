-- Release autopost: a steady, low-effort rhythm of posts about an artist's releases, scheduled to
-- their own Buffer (docs/specs/release-autopost-spec.md).
--
-- Two server-only tables, like buffer_connections: RLS is ENABLED with NO policies, deliberately.
-- The service-role client bypasses RLS and anon gets nothing; every read and write goes through
-- the functions after the verified-claim ownership check. The missing policies are the point,
-- not an oversight.
--
-- Upcoming posts are NOT stored. The planner (api/functions/autopost-plan.ts) is deterministic,
-- so the schedule is recomputed from the catalogue, the settings and these rows whenever it's
-- needed. A row exists only once a slot has been handed to Buffer (or tried), which is what
-- makes it history: spacing, template turns and image repeats are measured from it.

-- ---------------------------------------------------------------------------------------------
-- release_autopost_settings: one row per artist profile
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.release_autopost_settings (
  artist_id UUID PRIMARY KEY REFERENCES public.artists(id) ON DELETE CASCADE,

  -- Who set it up, and whose Buffer connection (buffer_connections.user_id) posts. Rechecked
  -- against artist_profiles on every run: a claim that changes hands stops the posting.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  enabled BOOLEAN NOT NULL DEFAULT false,
  -- When it was last switched on. Only releases catalogued after this get release moments, so
  -- switching on never floods a feed with the back catalogue.
  enabled_at TIMESTAMPTZ,

  -- NULL means "Recommended", which grows with the catalogue.
  posts_per_week SMALLINT CHECK (posts_per_week IS NULL OR posts_per_week BETWEEN 1 AND 7),
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  post_time TEXT NOT NULL DEFAULT '10:00' CHECK (post_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),

  -- Per artist, not per Buffer connection: two bands under one login post to different places.
  organization_id TEXT,
  channel_ids TEXT[] NOT NULL DEFAULT '{}',

  -- Kinds of post switched off, e.g. '{support,bandcamp_friday}'.
  kinds_off TEXT[] NOT NULL DEFAULT '{}',
  -- The artist's own variants per kind, { "catalogue": ["…", "…"], … }. A kind missing here
  -- uses Unstream's defaults (DEFAULT_TEMPLATES in api/shared/autopost-templates.ts).
  templates JSONB,

  -- Why posting stopped on its own (e.g. 'buffer_disconnected'). NULL while it's running. Set by
  -- the sweep and cleared when the artist fixes it, so the Promote tab can say what happened.
  paused_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.release_autopost_settings IS
  'Release autopost settings, one row per artist profile. Server-only: RLS on with no policies, read and written by the functions after the verified-claim check.';

ALTER TABLE public.release_autopost_settings ENABLE ROW LEVEL SECURITY;
-- No policies, on purpose. See the header.
REVOKE ALL ON public.release_autopost_settings FROM PUBLIC, anon, authenticated;

-- The sweep reads only the artists with it switched on.
CREATE INDEX IF NOT EXISTS idx_release_autopost_settings_enabled
  ON public.release_autopost_settings (artist_id) WHERE enabled;

-- ---------------------------------------------------------------------------------------------
-- release_autopost_posts: one row per slot handed to Buffer
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.release_autopost_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,

  -- When it posts, and the artist's local date for it (the planner's rules are about local days).
  slot_at TIMESTAMPTZ NOT NULL,
  slot_date DATE NOT NULL,

  kind TEXT NOT NULL CHECK (kind IN (
    'bandcamp_friday', 'release_day', 'preorder', 'out_now', 'still_new', 'catalogue', 'support'
  )),
  -- NULL for a call for support, and if the release is later deleted or merged away.
  release_id UUID REFERENCES public.releases(id) ON DELETE SET NULL,
  template_index SMALLINT NOT NULL DEFAULT 0,
  -- 'cover:{releaseId}', 'photo' or 'upload:{id}', and whether Instagram got it.
  image_key TEXT,
  image_on_instagram BOOLEAN NOT NULL DEFAULT false,

  -- pushing: claimed by a run, Buffer being called. A run that dies here leaves the slot
  --          claimed, which is the safe failure: a missed post rather than a doubled one.
  -- pushed:  in the artist's Buffer. Unstream never edits or deletes it after this.
  -- failed:  Buffer refused or couldn't be reached; retried by later runs up to 3 attempts.
  status TEXT NOT NULL DEFAULT 'pushing' CHECK (status IN ('pushing', 'pushed', 'failed')),
  attempts SMALLINT NOT NULL DEFAULT 1,

  -- [{ "channelId": "…", "postId": "…" }], one per channel Buffer accepted.
  buffer_post_ids JSONB NOT NULL DEFAULT '[]',
  -- Exactly what was sent, per channel: { channelId: { "service", "text", "imageUrl" } }.
  captions JSONB,
  -- Why a channel (or the whole slot) didn't go, in words.
  error TEXT,

  pushed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The claim: a second run reaching the same slot inserts nothing, so it can't double-post.
  UNIQUE (artist_id, slot_at)
);

COMMENT ON TABLE public.release_autopost_posts IS
  'Release autopost slots handed to Buffer (or tried). Upcoming posts are recomputed, not stored. Server-only: RLS on with no policies.';

ALTER TABLE public.release_autopost_posts ENABLE ROW LEVEL SECURITY;
-- No policies, on purpose. See the header.
REVOKE ALL ON public.release_autopost_posts FROM PUBLIC, anon, authenticated;

-- History for one artist, newest first: what spacing and variant turns are measured from.
CREATE INDEX IF NOT EXISTS idx_release_autopost_posts_artist_slot
  ON public.release_autopost_posts (artist_id, slot_at DESC);

-- ---------------------------------------------------------------------------------------------
-- releases.note: the artist's own line about a release, for {note}
-- ---------------------------------------------------------------------------------------------

-- Optional and per release, written on Manage Releases. When an artist writes it, 'note' joins
-- the release's curated_fields so a re-crawl never touches it (ingest never writes it anyway).
ALTER TABLE public.releases ADD COLUMN IF NOT EXISTS note TEXT
  CHECK (note IS NULL OR char_length(note) <= 280);

COMMENT ON COLUMN public.releases.note IS
  'The artist''s own line about this release (where it was recorded, what it''s about), used as {note} in release autopost templates. Written only by the verified artist.';
