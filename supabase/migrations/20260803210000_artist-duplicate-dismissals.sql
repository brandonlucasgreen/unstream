-- Migration: artist_duplicate_dismissals — remember that two same-named artists are NOT duplicates.
--
-- ## Why
--
-- `/admin/verify` lists every pair of artist rows whose names normalise alike, and 14 of the 27 on
-- production cannot be merged automatically because name similarity is not evidence. Several of them
-- are not duplicates at all and never will be:
--
--   Tigercub / Tiger Cub     two real bands, zero shared release titles
--   Honeycrush / Honey Crush Brooklyn and Orlando, separated on purpose by an earlier fix
--   Boto / Błoto             different artists whose names only collide once folded
--
-- Without this table those three sit in the review queue forever, and a queue that always shows the
-- same un-actionable rows is a queue nobody reads — which is how the real duplicates would get missed.
--
-- ## Keyed on the pair, not the name
--
-- The obvious key is the shared normalised name, but that would also hide a genuinely *new* third
-- artist who happens to normalise the same way. Keying on the two artist ids scopes the dismissal to
-- exactly the pair a human looked at.
--
-- `artist_id_a < artist_id_b` is enforced so a pair has one canonical representation: without it
-- (A,B) and (B,A) could both exist and a lookup would have to try both orders.
--
-- Deliberately NOT consulted by the duplicate *prevention* in persistSearchResults. That path matches
-- an incoming search result against a stored artist by shared platform URL, and the incoming result
-- has no artist row yet — so there is no pair to look up. Dismissal is about the review queue.

create table if not exists public.artist_duplicate_dismissals (
  artist_id_a uuid not null references public.artists(id) on delete cascade,
  artist_id_b uuid not null references public.artists(id) on delete cascade,
  -- Why a human decided they are different, e.g. "two bands, Brighton vs Leeds".
  note         text,
  -- Admin email, so a surprising dismissal can be asked about later.
  dismissed_by text,
  created_at   timestamptz not null default now(),

  primary key (artist_id_a, artist_id_b),
  constraint artist_duplicate_dismissals_ordered check (artist_id_a < artist_id_b)
);

-- Deleting either artist (including as the loser of a merge elsewhere) drops the dismissal via the
-- cascades above; this index serves the "what has this artist been dismissed against" direction.
create index if not exists idx_artist_duplicate_dismissals_b
  on public.artist_duplicate_dismissals (artist_id_b);

alter table public.artist_duplicate_dismissals enable row level security;

-- Intentionally no policies: written and read only by the admin endpoint through the service-role
-- client, which bypasses RLS. No anon or authenticated client ever touches it. Same pattern as
-- bandcamp_slug_probes and artist_slug_aliases — the missing policies are deliberate.

comment on table public.artist_duplicate_dismissals is
  'Pairs of same-named artists a human confirmed are different artists, so /admin/verify stops listing them. Keyed on the pair (a < b), never on the shared name.';
