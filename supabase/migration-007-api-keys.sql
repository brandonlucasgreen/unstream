-- Migration 007: API Keys table
-- Stores API keys for the public v1 API with SHA-256 hashed keys,
-- tiered rate limits, and owner tracking.

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT NOT NULL,
  owner_name TEXT,
  key_prefix TEXT NOT NULL,          -- First 12 chars of the API key for lookup
  key_hash TEXT NOT NULL UNIQUE,     -- SHA-256 hash of the full key
  tier TEXT NOT NULL DEFAULT 'free'  -- 'free' | 'pro' | 'internal'
    CHECK (tier IN ('free', 'pro', 'internal')),
  daily_limit INTEGER NOT NULL DEFAULT 100,
  per_minute INTEGER NOT NULL DEFAULT 30,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  description TEXT,                  -- Human-readable label for the key
  allowed_origins TEXT[]             -- Optional origin allowlist (empty = any)
);

-- Index for fast prefix-based lookups during authentication
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix) WHERE is_active = true;

-- RLS: service_role only (no direct public access)
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Explicit deny for anon/authenticated roles (defense in depth)
REVOKE ALL ON api_keys FROM anon, authenticated;

-- Enforce max 3 active keys per owner at the database level (prevents race conditions)
CREATE OR REPLACE FUNCTION check_api_key_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM api_keys
      WHERE owner_email = NEW.owner_email AND is_active = true) >= 3 THEN
    RAISE EXCEPTION 'api_key_limit_exceeded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_api_key_limit
  BEFORE INSERT ON api_keys
  FOR EACH ROW EXECUTE FUNCTION check_api_key_limit();