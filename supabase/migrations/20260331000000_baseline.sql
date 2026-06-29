-- Baseline migration: captures pre-migration schema.sql state
-- so that fresh DBs (branch previews) built from migrations only
-- match the prod DB that was originally set up via schema.sql.
--
-- Every statement is idempotent (IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS) so this is a no-op on prod where schema.sql
-- was applied long ago.
--
-- Source: supabase/schema.sql (canonical baseline)

-- ── Tables ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.artists (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  image_url text,
  match_confidence text check (match_confidence in ('verified', 'unverified')),
  source text not null default 'auto',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_enriched_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.artist_links (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  platform text not null,
  url text not null,
  source text not null default 'search',
  is_direct boolean not null default true,
  latest_release jsonb,
  display_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(artist_id, platform)
);

CREATE TABLE IF NOT EXISTS public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  user_id uuid not null,
  email text not null,
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_notes text,
  ownership_verified_by uuid,
  ownership_verified_at timestamptz
);

-- ── Indexes ─────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_artists_slug ON public.artists(slug);
CREATE INDEX IF NOT EXISTS idx_artists_updated ON public.artists(updated_at);
CREATE INDEX IF NOT EXISTS idx_artist_links_artist_id ON public.artist_links(artist_id);
CREATE INDEX IF NOT EXISTS idx_verification_requests_artist_id ON public.verification_requests(artist_id);
CREATE INDEX IF NOT EXISTS idx_verification_requests_status ON public.verification_requests(status);

-- ── Function ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Row Level Security ──────────────────────────────────────────────

ALTER TABLE public.artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.artist_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_requests ENABLE ROW LEVEL SECURITY;

-- ── Policies ────────────────────────────────────────────────────────

-- artists
DROP POLICY IF EXISTS "Public read access" ON public.artists;
CREATE POLICY "Public read access" ON public.artists
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Service insert" ON public.artists;
CREATE POLICY "Service insert" ON public.artists
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Service update" ON public.artists;
CREATE POLICY "Service update" ON public.artists
  FOR UPDATE USING (true);

-- artist_links
DROP POLICY IF EXISTS "Public read access" ON public.artist_links;
CREATE POLICY "Public read access" ON public.artist_links
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Service insert" ON public.artist_links;
CREATE POLICY "Service insert" ON public.artist_links
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Service update" ON public.artist_links;
CREATE POLICY "Service update" ON public.artist_links
  FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Service delete" ON public.artist_links;
CREATE POLICY "Service delete" ON public.artist_links
  FOR DELETE USING (true);

-- verification_requests
DROP POLICY IF EXISTS "Users can read own verification requests" ON public.verification_requests;
CREATE POLICY "Users can read own verification requests"
  ON public.verification_requests FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access" ON public.verification_requests;
CREATE POLICY "Service role full access"
  ON public.verification_requests FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── Triggers ────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS artists_updated_at ON public.artists;
CREATE TRIGGER artists_updated_at
  BEFORE UPDATE ON public.artists
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS artist_links_updated_at ON public.artist_links;
CREATE TRIGGER artist_links_updated_at
  BEFORE UPDATE ON public.artist_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();