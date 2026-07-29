-- Unstream Artist Database Schema
-- Run this in your Supabase SQL editor to set up the tables.
--
-- This file is the canonical baseline. Migrations 002, 006, 008, 010,
-- 019, and 029 are reflected here. Run migrations in order on an existing DB;
-- use this file for fresh installs.
--
-- Migration 008: verification_code → nullable
-- Migration 010: website_url → nullable

-- Artists table: one row per unique artist
create table artists (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  image_url text,
  match_confidence text check (match_confidence in ('verified', 'unverified')),
  source text not null default 'auto', -- 'auto' | 'claimed'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_enriched_at timestamptz -- when MusicBrainz enrichment was last applied
);

-- Artist links table: platform links for each artist
create table artist_links (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  platform text not null,
  url text not null,
  source text not null default 'search', -- 'search' | 'musicbrainz' | 'claimed'
  is_direct boolean not null default true,
  latest_release jsonb, -- { title, type, url, imageUrl, releaseDate }
  display_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(artist_id, platform)
);

create index idx_artists_slug on artists(slug);
create index idx_artists_updated on artists(updated_at);
create index idx_artist_links_artist_id on artist_links(artist_id);

-- Artist profiles: extended info for claimed artists
-- (Migration 002; columns updated by migrations 008 and 010)
create table artist_profiles (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid unique not null references artists(id) on delete cascade,
  user_id uuid not null,  -- Supabase Auth user ID
  email text not null,
  bio text,               -- Short artist bio (max 500 chars)
  custom_image_url text,  -- Artist-uploaded image (overrides auto image)
  website_url text,       -- Verified official website / linktree (nullable per migration 010)
  verification_code text, -- Legacy code for link-back verification (nullable per migration 008)
  verified_at timestamptz,  -- null until verification passes
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_artist_profiles_artist_id on artist_profiles(artist_id);
create index idx_artist_profiles_user_id on artist_profiles(user_id);

alter table artist_profiles enable row level security;

create policy "Public read verified profiles" on artist_profiles
  for select using (verified_at is not null);
create policy "Owner read own profile" on artist_profiles
  for select using (auth.uid() = user_id);
create policy "Service insert profiles" on artist_profiles
  for insert with check (true);
create policy "Service update profiles" on artist_profiles
  for update using (true);

create trigger artist_profiles_updated_at
  before update on artist_profiles
  for each row execute function update_updated_at();

-- Verification requests: manual review fallback for artist claims
-- (Migration 006; ownership columns added by migration 019)
create table verification_requests (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  user_id uuid not null,  -- Supabase Auth user ID
  email text not null,
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_notes text,
  ownership_verified_by uuid,   -- Migration 019
  ownership_verified_at timestamptz  -- Migration 019
);

create index idx_verification_requests_artist_id on verification_requests(artist_id);
create index idx_verification_requests_status on verification_requests(status);

alter table verification_requests enable row level security;

create policy "Users can read own verification requests"
  on verification_requests for select
  using (auth.uid() = user_id);

create policy "Service role full access"
  on verification_requests for all
  using (true)
  with check (true);

-- Enable Row Level Security (permissive for now — tighten when adding auth)
alter table artists enable row level security;
alter table artist_links enable row level security;

-- Allow public read access (the API uses the anon key)
create policy "Public read access" on artists for select using (true);
create policy "Public read access" on artist_links for select using (true);

-- Allow service role to insert/update (used by Netlify functions with service key)
create policy "Service insert" on artists for insert with check (true);
create policy "Service update" on artists for update using (true);
create policy "Service insert" on artist_links for insert with check (true);
create policy "Service update" on artist_links for update using (true);
create policy "Service delete" on artist_links for delete using (true);

-- Function to auto-update updated_at timestamp
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger artists_updated_at
  before update on artists
  for each row execute function update_updated_at();

create trigger artist_links_updated_at
  before update on artist_links
  for each row execute function update_updated_at();

-- Artist releases: one row per release per artist (Migration 029)
create table artist_releases (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  title text not null,
  slug text not null,  -- slugified title, unique per artist
  release_type text not null check (release_type in ('album', 'single', 'ep', 'compilation')),
  release_date date,
  artwork_url text,
  musicbrainz_id text,  -- MB release group ID for deduplication
  source text not null default 'auto',  -- 'auto' | 'claimed'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(artist_id, slug)
);

create index idx_artist_releases_artist_id on artist_releases(artist_id);
  create index idx_artist_releases_musicbrainz_id on artist_releases(musicbrainz_id);

alter table artist_releases enable row level security;

create policy "Public read access" on artist_releases for select using (true);
create policy "Service insert" on artist_releases for insert to service_role with check (true);
create policy "Service update" on artist_releases for update to service_role using (true);
create policy "Service delete" on artist_releases for delete to service_role using (true);

create trigger artist_releases_updated_at
  before update on artist_releases
  for each row execute function update_updated_at();

-- Release links: one row per platform link per release (Migration 029)
create table release_links (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references artist_releases(id) on delete cascade,
  platform text not null,
  url text not null,
  is_streaming boolean not null default true,  -- true for Spotify/Apple, false for Bandcamp/merch
  source text not null default 'auto',  -- 'auto' | 'claimed' | 'bandcamp' | 'mirlo' | 'musicbrainz' | 'itunes'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(release_id, platform)
);

create index idx_release_links_release_id on release_links(release_id);

alter table release_links enable row level security;

create policy "Public read access" on release_links for select using (true);
create policy "Service insert" on release_links for insert to service_role with check (true);
create policy "Service update" on release_links for update to service_role using (true);
create policy "Service delete" on release_links for delete to service_role using (true);

create trigger release_links_updated_at
  before update on release_links
  for each row execute function update_updated_at();
