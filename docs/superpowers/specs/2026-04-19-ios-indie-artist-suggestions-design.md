# iOS Search tab: Indie Artist Index suggestions

**Date:** 2026-04-19
**Scope:** iOS app (`apps/mac/Unstream`, iOS target)
**Status:** Design approved

## Problem

The iOS app's Search tab is the de facto home screen, but in its empty state it shows only a music-note icon and a "Search for an artist..." prompt. There's no discovery surface — users with no specific artist in mind have nothing to do.

We already maintain the Indie Artist Index (~100 verified indie artists, exposed at `/api/artist-directory`). Surfacing a random sample of these artists on the empty Search tab gives the page a discovery purpose without adding new backend work.

## User experience

When the user opens the Search tab with no active query, they see:

1. **Bandcamp Friday badge** (when active) — pinned at the top, unchanged from today
2. **Section header** — "Discover indie artists" with subtitle "Tap any artist to find them on platforms that pay fairly"
3. **2-column grid** of 30 randomly-selected artists from the Indie Artist Index, each shown as a large circular photo with the artist's name beneath

**Interactions:**

- **Tap an artist** → populates the search bar with the artist's name and runs the existing search flow. The grid is replaced by search results.
- **Pull to refresh** → re-fetches the directory and reshuffles the displayed sample.
- **Clear the search query** → returns to the grid, preserving the current sample for the rest of the session.

**Failure fallback:** if the directory fails to load and no local cache exists, render the existing music-note-icon empty state. The Bandcamp Friday badge still appears when active.

## Architecture

No backend changes. `/api/artist-directory` already returns `{ artists: [{ slug, name, imageUrl }] }`.

### New Swift files

Under `apps/mac/Unstream/`:

- **`Models/IndieArtist.swift`** — `Codable` struct: `slug: String`, `name: String`, `imageUrl: String?`
- **`Services/IndieArtistDirectoryService.swift`** — `@MainActor` `ObservableObject`:
  - `@Published var artists: [IndieArtist]` — full directory
  - `@Published var sample: [IndieArtist]` — the 30 currently displayed
  - `@Published var loadState: LoadState` (`idle | loading | loaded | failed`)
  - `loadIfNeeded()` — fires a background fetch; if `sample` is empty after the fetch, generates one
  - `refresh()` — re-fetches and reshuffles (used by pull-to-refresh)
  - `reshuffle()` — picks a new random 30 from `artists`
  - On `init`, synchronously reads cached JSON if present and seeds `artists` + initial `sample`
- **`Views/iOS/IndieArtistSuggestionsView.swift`** — header + 2-column `LazyVGrid` of cards; handles `.refreshable` and the failure fallback
- **`Views/iOS/IndieArtistCard.swift`** — single tile: `AsyncImage` circle + name. Placeholder is a gray circle with the artist's first initial (matches the web Indie Artist Index fallback).

### Modified files

- **`Views/iOS/SearchTab.swift`** — replace the empty-state branch (the `else` at line 34) with `IndieArtistSuggestionsView`. The Bandcamp Friday badge moves into `IndieArtistSuggestionsView` so it appears above the header when active.
- **`Views/iOS/iOSContentView.swift`** — instantiate `IndieArtistDirectoryService` once at the iOS app root and inject it as an `@EnvironmentObject`.

### Data flow

1. **App launch** → `IndieArtistDirectoryService.init` reads `indie-artist-directory.json` from the Caches directory if present, populating `artists` and an initial `sample`. `loadState` starts as `idle` if no cache, `loaded` if cache present.
2. **Search tab appears** → `loadIfNeeded()` runs a background fetch against `/api/artist-directory`. On success, replaces `artists`, persists to cache, and generates a `sample` if one doesn't exist yet. A background refresh does **not** reshuffle an existing sample — only an explicit pull-to-refresh does.
3. **Pull-to-refresh** → `refresh()` re-fetches and then reshuffles regardless of fetch outcome (so the user always sees something change).
4. **Failure with no cache** → `loadState = .failed`, view renders the existing empty-state hero.

## Implementation details

- **Random sample:** `artists.shuffled().prefix(30)`. If the directory has fewer than 30 artists, all of them are shown.
- **Cache file:** `<Caches>/indie-artist-directory.json`. Caches directory is correct here — the OS may purge it under storage pressure, which is fine since we always re-fetch on next view appearance.
- **Network:** add a `fetchArtistDirectory()` method to the existing `UnstreamAPI` class (`apps/mac/Unstream/UnstreamAPI.swift`), which already centralizes the `https://unstream.stream/api` base URL and is used by the search flow. The new method hits `/api/artist-directory`. No auth required.
- **Image loading:** SwiftUI `AsyncImage`; rely on `URLCache` defaults for ~30 thumbnails. No bespoke image cache.
- **Tap behavior:** sets `appState.searchQuery = artist.name`, then calls `await appState.performSearch()`. The existing `.searchable` modifier picks up the new value.
- **Grid:** `LazyVGrid` with 2 flexible columns, ~16pt spacing, ~150pt circle photos on a typical iPhone width. Wrapped in the existing `ScrollView` (already in `SearchTab`) with `.refreshable { await service.refresh() }`.

## Testing

Swift unit tests for `IndieArtistDirectoryService`:

- Cache round-trip: write directory → reinitialize service → reads same artists
- Sample size: directory with < 30 artists returns all of them; directory with > 30 returns exactly 30
- `reshuffle()` produces a different ordering when called repeatedly (seeded RNG to make this deterministic)
- Load failure with existing cache returns cached `artists` and keeps `loadState` as `.loaded`
- Load failure with no cache sets `loadState = .failed` and leaves `artists` empty

No UI tests for the grid view itself — the existing iOS test scope is unit tests for services/models only.

## Out of scope

- Native artist detail screen (considered, deferred — tap behavior reuses the existing search flow)
- Editorial curation of "Featured" artists (random sample is enough at ~100 artists)
- Reshuffle on app launch (only pull-to-refresh reshuffles)
- Image caching beyond `URLCache` defaults
