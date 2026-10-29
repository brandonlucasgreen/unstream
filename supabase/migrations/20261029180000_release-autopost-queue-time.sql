-- Release autopost: a "Recommended" posting time, which is the artist's own Buffer queue
-- (docs/specs/release-autopost-spec.md, "How often"). Brandon, 2026-10-29.
--
-- NULL post_time now means "add each post to the channel's Buffer queue on its planned day",
-- so Buffer's posting schedule picks the time. A set time still schedules for exactly then.
-- It's the default for new artists. The existing CHECK passes NULL, so only the NOT NULL and
-- the default change.

ALTER TABLE public.release_autopost_settings ALTER COLUMN post_time DROP NOT NULL;
ALTER TABLE public.release_autopost_settings ALTER COLUMN post_time SET DEFAULT NULL;

COMMENT ON COLUMN public.release_autopost_settings.post_time IS
  'Local HH:MM to schedule each post for, or NULL for "Recommended": the post is added to the channel''s Buffer queue on its planned day and Buffer''s posting schedule picks the time.';
