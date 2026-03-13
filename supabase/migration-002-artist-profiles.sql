-- Migration 002: Artist Profiles & Claim Flow
-- Run this in your Supabase SQL editor after enabling Supabase Auth.

-- Update match_confidence to support 'claimed'
alter table artists drop constraint if exists artists_match_confidence_check;
alter table artists add constraint artists_match_confidence_check
  check (match_confidence in ('verified', 'unverified', 'claimed'));

-- Artist profiles: extended info for claimed artists
create table artist_profiles (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid unique not null references artists(id) on delete cascade,
  user_id uuid not null,  -- Supabase Auth user ID
  email text not null,
  bio text,               -- Short artist bio (max 500 chars)
  custom_image_url text,  -- Artist-uploaded image (overrides auto image)
  website_url text not null, -- Verified official website / linktree
  verification_code text not null, -- Unique code for link-back verification
  verified_at timestamptz,  -- null until verification passes
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_artist_profiles_artist_id on artist_profiles(artist_id);
create index idx_artist_profiles_user_id on artist_profiles(user_id);

-- RLS for artist_profiles
alter table artist_profiles enable row level security;

-- Public can read verified profiles
create policy "Public read verified profiles" on artist_profiles
  for select using (verified_at is not null);

-- Authenticated users can read their own profile (even if not yet verified)
create policy "Owner read own profile" on artist_profiles
  for select using (auth.uid() = user_id);

-- Service role handles inserts and updates
create policy "Service insert profiles" on artist_profiles
  for insert with check (true);
create policy "Service update profiles" on artist_profiles
  for update using (true);

-- Auto-update timestamp
create trigger artist_profiles_updated_at
  before update on artist_profiles
  for each row execute function update_updated_at();
