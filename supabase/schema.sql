-- Unstream Artist Database Schema
-- Run this in your Supabase SQL editor to set up the tables.

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
