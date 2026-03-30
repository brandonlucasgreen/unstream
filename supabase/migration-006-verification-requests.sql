-- Migration 006: Create verification_requests table for manual review fallback
-- When automated scraper-based verification fails, artists can submit a manual
-- review request with proof of identity.

CREATE TABLE IF NOT EXISTS verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewer_notes TEXT
);

-- Index for looking up requests by artist
CREATE INDEX idx_verification_requests_artist_id ON verification_requests(artist_id);

-- Index for admin review queue (pending requests)
CREATE INDEX idx_verification_requests_status ON verification_requests(status);

-- Enable RLS
ALTER TABLE verification_requests ENABLE ROW LEVEL SECURITY;

-- Users can read their own requests
CREATE POLICY "Users can read own verification requests"
  ON verification_requests
  FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can do everything (Netlify functions use service key)
CREATE POLICY "Service role full access"
  ON verification_requests
  FOR ALL
  USING (true)
  WITH CHECK (true);
