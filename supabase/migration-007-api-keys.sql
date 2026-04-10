-- Migration 007: API Keys table
-- Stores API keys for the public v1 API with SHA-256 hashed keys,
-- tiered rate limits, and owner tracking.

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT NOT NULL,
  owner_name TEXT,
  key_prefix TEXT NOT NULL,          -- First 8 chars of the API key for lookup
  key_hash TEXT NOT NULL UNIQUE,     -- SHA-256 hash of the full key
  tier TEXT NOT NULL DEFAULT 'free'  -- 'free' | 'pro' | 'internal'
    CHECK (tier IN ('free', 'pro', 'internal')),
  daily_limit INTEGER NOT NULL DEFAULT 100,
  per_second INTEGER NOT NULL DEFAULT 5,
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

-- No public policies — all access goes through serverless functions
-- using the service_role key.