// Supabase database module for the Unstream artist database.
// All operations are optional — if Supabase is not configured, they no-op gracefully.
//
// This file is only the front door: the helpers live in ./db/, one module per area, and are
// re-exported here so every importer and every test keeps the path './db'.
//
//   client            the one Supabase client, and readAllPages
//   artists           reading artists: by slug, aliases, suggestions, lookups by name
//   search-persist    what a search writes: artist rows, links, enrichment
//   admin-lists       merge overrides and link suppressions, with their cache and memo
//   catalog           catalogue state, the sweep's candidates, the artist a pass works on
//   release-persist   what a catalogue pass writes: releases, sources, dedup, per platform
//   release-review    the tier-3 dedup review queue, and merging two releases
//   release-curation  a verified artist's edits to their own releases
//   bandcamp-probes   the Bandcamp slug-probe cache
//   release-reads     releases for artist pages, the release page and alerts
//   release-feeds     calendar and RSS feeds, and feed tokens
//
// Add a helper to the module it belongs with, not here. Modules in ./db/ import each other
// directly ('./client'), never through this file: tests mock this path.

export * from './db/client';
export * from './db/artists';
export * from './db/search-persist';
export * from './db/admin-lists';
export * from './db/catalog';
export * from './db/release-persist';
export * from './db/release-review';
export * from './db/release-curation';
export * from './db/bandcamp-probes';
export * from './db/release-reads';
export * from './db/release-feeds';
