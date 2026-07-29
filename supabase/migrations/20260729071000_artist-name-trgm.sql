-- Migration: trigram index on artists.name for the /api/suggest typeahead endpoint.
--
-- Before this, the only name access paths were slug equality lookups
-- (idx_artists_slug); a substring search like ILIKE '%argen%' would be a
-- sequential scan over the whole table. pg_trgm + a GIN index turns that into
-- an index scan, which is what makes search-as-you-type viable.
--
-- No RLS change: the suggest endpoint reads through the service-role client
-- like all other search-path DB access, and this migration adds no tables or
-- columns.

create extension if not exists pg_trgm;

create index if not exists idx_artists_name_trgm
  on artists using gin (name gin_trgm_ops);
