-- Batch variant of increment_analytics (migration 003).
--
-- One search response renders every claimed artist it matched, and the web client used to POST
-- one analytics event per rendered card — N requests, N transactions, for one user action. The
-- client now sends the whole burst as a single { slugs: [...], metric } request, and this
-- function applies it as one INSERT ... ON CONFLICT statement: one transaction however many
-- artists appeared. Part of the second Disk IO Budget fix round (2026-08-19).
--
-- DISTINCT because ON CONFLICT DO UPDATE refuses to touch the same row twice within one
-- INSERT ("cannot affect row a second time") — a duplicated id must collapse before the write,
-- which does mean a duplicate counts once, matching the deduplication the endpoint already does.
--
-- SECURITY DEFINER for the same reason as increment_analytics: it runs with owner privileges so
-- event ingestion can write rows that RLS otherwise reserves for the artist reading their own
-- stats. CREATE OR REPLACE keeps the migration idempotent.
CREATE OR REPLACE FUNCTION increment_analytics_batch(
  p_artist_ids UUID[],
  p_date DATE,
  p_metric TEXT
) RETURNS void AS $$
BEGIN
  INSERT INTO artist_analytics (artist_id, date, metric, count)
  SELECT DISTINCT id, p_date, p_metric, 1
  FROM unnest(p_artist_ids) AS id
  ON CONFLICT (artist_id, date, metric)
  DO UPDATE SET count = artist_analytics.count + 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
