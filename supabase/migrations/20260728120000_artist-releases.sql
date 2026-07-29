-- Migration 029: Release catalog tables (Unstream Releases)
--
-- Lifts release data out of the artist_links.latest_release jsonb blob into
-- proper release entities with per-release platform links. The jsonb column
-- stays (still used for search disambiguation); these tables are additive.
--
-- Two tables:
--   artist_releases — one row per release per artist (album, single, EP, etc.)
--   release_links   — one row per platform link per release
--
-- RLS: public read, service write — same pattern as artists / artist_links.
-- The update_updated_at() function and trigger pattern already exist from
-- the base schema; we reuse it here.

-- ── artist_releases ──────────────────────────────────────────────────────

create table if not exists public.artist_releases (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  title text not null,
  slug text not null,                         -- slugified title, unique per artist
  release_type text not null check (release_type in ('album', 'single', 'ep', 'compilation')),
  release_date date,
  artwork_url text,
  musicbrainz_id text,                        -- MB release group ID for deduplication
  source text not null default 'auto',        -- 'auto' | 'claimed'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(artist_id, slug)
);

create index if not exists idx_artist_releases_artist_id on public.artist_releases(artist_id);
create index if not exists idx_artist_releases_musicbrainz_id on public.artist_releases(musicbrainz_id);

alter table public.artist_releases enable row level security;

-- Public read (same as artists / artist_links)
drop policy if exists "Public read access" on public.artist_releases;
create policy "Public read access" on public.artist_releases for select using (true);

-- Service-role write (service key bypasses RLS, but policies document intent)
drop policy if exists "Service insert" on public.artist_releases;
create policy "Service insert" on public.artist_releases for insert to service_role with check (true);
drop policy if exists "Service update" on public.artist_releases;
create policy "Service update" on public.artist_releases for update to service_role using (true);
drop policy if exists "Service delete" on public.artist_releases;
create policy "Service delete" on public.artist_releases for delete to service_role using (true);

-- updated_at trigger (reuses existing update_updated_at() function)
drop trigger if exists artist_releases_updated_at on public.artist_releases;
create trigger artist_releases_updated_at
  before update on public.artist_releases
  for each row execute function public.update_updated_at();

-- ── release_links ────────────────────────────────────────────────────────

create table if not exists public.release_links (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.artist_releases(id) on delete cascade,
  platform text not null,
  url text not null,
  is_streaming boolean not null default true,  -- true for Spotify/Apple, false for Bandcamp/merch
  source text not null default 'auto',         -- 'auto' | 'claimed' | 'bandcamp' | 'mirlo' | 'musicbrainz' | 'itunes'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(release_id, platform)
);

create index if not exists idx_release_links_release_id on public.release_links(release_id);

alter table public.release_links enable row level security;

drop policy if exists "Public read access" on public.release_links;
create policy "Public read access" on public.release_links for select using (true);

drop policy if exists "Service insert" on public.release_links;
create policy "Service insert" on public.release_links for insert to service_role with check (true);
drop policy if exists "Service update" on public.release_links;
create policy "Service update" on public.release_links for update to service_role using (true);
drop policy if exists "Service delete" on public.release_links;
create policy "Service delete" on public.release_links for delete to service_role using (true);

drop trigger if exists release_links_updated_at on public.release_links;
create trigger release_links_updated_at
  before update on public.release_links
  for each row execute function public.update_updated_at();