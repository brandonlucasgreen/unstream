-- Migration 003: Artist Analytics
-- Daily rollup counts for anonymous, aggregate artist analytics.
-- Stores search appearances, page views, and link clicks per artist per day.

CREATE TABLE artist_analytics (
  artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artist_id, date, metric)
);

-- Index for dashboard queries: fetch all metrics for an artist within a date range
CREATE INDEX idx_artist_analytics_lookup ON artist_analytics (artist_id, date DESC);

-- Row-Level Security
ALTER TABLE artist_analytics ENABLE ROW LEVEL SECURITY;

-- Verified artist owners can read their own analytics
CREATE POLICY "Artists can read own analytics"
  ON artist_analytics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM artist_profiles
      WHERE artist_profiles.artist_id = artist_analytics.artist_id
        AND artist_profiles.user_id = auth.uid()
        AND artist_profiles.verified_at IS NOT NULL
    )
  );

-- Atomic upsert-increment function for event ingestion.
-- SECURITY DEFINER runs with owner privileges, bypassing RLS for inserts.
CREATE OR REPLACE FUNCTION increment_analytics(
  p_artist_id UUID,
  p_date DATE,
  p_metric TEXT
) RETURNS void AS $$
BEGIN
  INSERT INTO artist_analytics (artist_id, date, metric, count)
  VALUES (p_artist_id, p_date, p_metric, 1)
  ON CONFLICT (artist_id, date, metric)
  DO UPDATE SET count = artist_analytics.count + 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
