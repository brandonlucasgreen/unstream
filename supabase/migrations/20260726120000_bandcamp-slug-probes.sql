-- Migration 025: Bandcamp slug-probe cache (UNS-152)
--
-- bandcamp.com/search is behind a Fastly bot challenge and is Disallow'ed in
-- Bandcamp's robots.txt, so artist URLs are now found by probing candidate
-- subdomains (<slug>.bandcamp.com) derived from the search query and verifying
-- the result. See docs/specs/bandcamp-coverage-research.md.
--
-- This table caches probe outcomes so each distinct query costs at most one
-- round of probes, ever. Caching NEGATIVES matters as much as positives: without
-- it, every search for an artist who simply isn't on Bandcamp re-probes on every
-- single search, indefinitely.
--
-- No PII: `query_norm` is a normalized artist-name search term, not user data.
-- Reads and writes go through the service-role client in Netlify functions, so
-- RLS is enabled with no public policies (anon gets nothing; service role
-- bypasses RLS).

create table if not exists public.bandcamp_slug_probes (
  -- Normalized search query (lowercased, punctuation stripped). Primary key:
  -- lookups are always by query, and one row per query is exactly what we want.
  query_norm    text primary key,

  -- Resolved Bandcamp artist URL. NULL is meaningful — it is the cached
  -- negative ("we looked, there is nothing to link to").
  artist_url    text,

  -- Verified identity from the page's data-band attribute, kept for auditing
  -- why a decision was made and for the /admin/verify queue.
  band_name     text,
  band_id       bigint,

  -- Release counts at probe time. 0 albums AND 0 tracks is the squatter
  -- signature (e.g. beyonce/sufjan/jackwhite are parked, name-matching, empty).
  album_count   int  not null default 0,
  track_count   int  not null default 0,

  -- Which slug candidate won, for tuning candidate ordering later.
  matched_slug  text,

  -- Outcome of the probe:
  --   accepted        verified artist, artist_url is set
  --   absent          no candidate slug resolved to an account
  --   rejected_empty  account exists and name matches, but has no releases
  --   rejected_name   account exists but data-band name did not match the query
  --   pending_review  non-empty and name matches, but cross-source release
  --                   matching contradicted it -- routed to /admin/verify
  verdict       text not null check (verdict in (
                  'accepted', 'absent', 'rejected_empty',
                  'rejected_name', 'pending_review'
                )),

  checked_at    timestamptz not null default now()
);

-- Stale negatives should be re-probed periodically (an artist may join Bandcamp
-- later); positives are stable. Supports "find rows to refresh" scans.
create index if not exists idx_bandcamp_slug_probes_verdict_checked
  on public.bandcamp_slug_probes (verdict, checked_at);

-- Feeds the /admin/verify queue.
create index if not exists idx_bandcamp_slug_probes_pending
  on public.bandcamp_slug_probes (checked_at desc)
  where verdict = 'pending_review';

alter table public.bandcamp_slug_probes enable row level security;

-- Intentionally no policies: this cache is server-only. The service-role client
-- bypasses RLS; anon and authenticated clients get no access.

comment on table public.bandcamp_slug_probes is
  'Cache of Bandcamp subdomain probe outcomes, positive and negative (UNS-152). Server-only; no RLS policies by design.';
comment on column public.bandcamp_slug_probes.artist_url is
  'Resolved Bandcamp artist URL; NULL is the cached negative result.';
