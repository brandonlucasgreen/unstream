-- Migration: artist_slug_aliases — keep an artist reachable at a slug they used to have.
--
-- ## Why
--
-- Two things need this, both of which otherwise break URLs that already exist.
--
-- 1. **Merging duplicate artist rows.** The same artist can hold two rows with two slugs, so a
--    merge deletes one of them. Without an alias the loser's URL starts 404ing, and those URLs are
--    real: `/a/honeycrush` and `/a/kidlightbulbs` are as linkable as any other page.
--
-- 2. **Fixing accented slugs.** `artistSlug()` mapped every non-`[a-z0-9]` character to `-`, so
--    `Björk` became `bj-rk`, `Sébastien Tellier` became `sebastien-tellier`'s ugly cousin
--    `s-bastien-tellier`, and `Choan Gálvez` became `choan-g-lvez`. Folding accents instead
--    (`bjork`) is the fix, but it changes what the slug *computes to* — and `persistSearchResults`
--    upserts `on conflict (slug)`. So the next search for an accented artist would no longer match
--    their stored row and would create a third one. Re-slugging the row to the folded form and
--    aliasing the old slug is what makes that fix safe.
--
-- ## Lookup order matters
--
-- Callers resolve the real `artists.slug` FIRST and only consult this table on a miss. A live slug
-- must always win, so an alias can never shadow a real artist that later takes that slug — and it
-- also means the alias lookup costs nothing on the hot path (`getArtistBySlug` runs at the front of
-- every search; only the artist-page callers ask about aliases).

create table if not exists public.artist_slug_aliases (
  -- The retired slug. Primary key, so one alias resolves to exactly one artist and the same slug
  -- can't be claimed twice.
  alias      text primary key,
  artist_id  uuid not null references public.artists(id) on delete cascade,
  -- Why the alias exists: 'merge' (loser of a duplicate merge) or 'reslug' (accent fix).
  reason     text not null check (reason in ('merge', 'reslug')),
  created_at timestamptz not null default now()
);

-- Every lookup is "find the artist for this alias", which the primary key already serves. This
-- index is for the reverse direction — listing an artist's old slugs when reviewing a merge.
create index if not exists idx_artist_slug_aliases_artist
  on public.artist_slug_aliases (artist_id);

alter table public.artist_slug_aliases enable row level security;

-- Intentionally no policies: every reader is server-side and uses the service-role client, which
-- bypasses RLS. The artist page is rendered by an edge function and the SPA gets its data from a
-- serverless function, so no anon client ever needs this table. Same pattern as
-- bandcamp_slug_probes — the missing policies are deliberate, not an oversight.

comment on table public.artist_slug_aliases is
  'Retired artist slugs (merge losers, accent re-slugs) so old URLs keep resolving. Server-only; resolved after artists.slug misses, never before.';
