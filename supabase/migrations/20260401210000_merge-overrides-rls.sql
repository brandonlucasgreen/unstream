-- Migration 005: Enable public read access for artist_merge_overrides
-- RLS is enabled by default on Supabase tables. Without a policy, only
-- the service role key can read rows. This adds a SELECT policy so the
-- anon key (used by Netlify functions) can also read overrides.

ALTER TABLE artist_merge_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access"
  ON artist_merge_overrides
  FOR SELECT
  USING (true);

-- Allow service-role inserts (Netlify functions use the service key,
-- but explicitly granting INSERT avoids edge cases where the client
-- doesn't fully bypass RLS).
CREATE POLICY "Allow service role insert"
  ON artist_merge_overrides
  FOR INSERT
  WITH CHECK (true);
