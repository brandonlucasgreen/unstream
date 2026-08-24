# Library support scan

**Status:** specced, not built. Supersedes the Apple Music "library import" product (Support Loop
Step 2), whose Settings UI was removed on 2026-08-23. The library *reader* it was built on is kept
and reused.

## The idea

Scan the listener's Music library for **artists who already have an Unstream artist page with a
verified direct-support link**, and offer those — and only those — to save. Nothing else about the
library is surfaced, stored, or shown.

The library stops being a collection to inventory and becomes a lookup key. Brandon, 2026-08-23:

> I also like the idea of *scanning my library for artists that already have artist pages and
> verified support links*. That's the best idea here.

## Why this shape, and not the two we rejected

**Rejected: import the library as a collection.** A 33,909-track library is 3,359 unique
artist-albums, and Unstream cannot honestly call any of it a purchase — Music's `cloud status`
distinguishes "a file on this disk" (`matched`, `uploaded`, `purchased`) from "a subscription
stream", and a local file could be a rip, a gift, or a promo. The provenance mapping already
refuses to claim otherwise (`owned`/`listened`, never `purchased`, and only `purchased` renders
publicly). Building a review flow over 3,359 unverifiable items spends a lot of UI on data that
cannot support the one claim that matters. Brandon:

> i'm not sure it's actually a goal of Unstream to show off 10,000 album collections, especially if
> we can't definitively prove that all those albums were bought (Vs pirated or something else).

**Rejected: auto-save the top 20 most-played artists.** Tested against real data, most-played is a
poor proxy for would-support. From Brandon's library:

| rank | artist | plays | owned tracks | why it's wrong |
|---|---|---|---|---|
| 1 | Raffi | 7,899 | 0 | kids' music, played by a child |
| 4 | Fleetwood Mac | 1,451 | 0 | major label, no direct-support route |
| 9 | Taken By Name | 902 | 58 | **his own former alias** — not an active artist |
| 12 | Ocean Waves Radiance & Ocean Waves For Sleep | 782 | 0 | sleep noise |

Four of the top twelve are wrong, and one is the user himself. Auto-saving also breaks a decision
already made (2026-08-16, spec OQ6 reversal): a save subscribes you to release alerts, so bulk
saving on inferred data buries the alerts that matter. **Every save in this flow is picked and
confirmed by the user.** See `feedback_inferred_data_stays_out_of_deliberate_lists`.

## What the user sees

One screen, reachable from Mac app Settings → Integrations:

1. **Before**: a single button — "Find artists you can support directly" — with one line saying it
   reads artist names from your Music library, sends only those names, and stores nothing else.
2. **Scanning**: progress. Two phases, both fast: local read (~1s for 34k tracks), then one
   batched request.
3. **Results**: a list of matched artists only, each row showing artist name, plays in your
   library, and the support platforms found (e.g. "Bandcamp · 82% to artist"). Each row has a
   checkbox, default **off**. A "Select all" affordance. Rows for artists already saved are shown
   as already saved and are not selectable.
4. **Confirm**: "Save N artists" — writes them via the existing saved-artists path, which
   subscribes to release alerts. Copy must say that in the button's vicinity, not in a footer.
5. **After**: a summary — "Saved 12 artists · 43 more had pages but no direct-support link yet" —
   and no persisted library data.

Non-goals for v1: album/release matching, provenance display, a collection view, anything on the
web, iOS (the library reader is macOS-only), Spotify.

## What it takes to build

Most of the machinery exists.

**Already done:**

| piece | where |
|---|---|
| Library read (batched Apple events, sandbox-safe) | `AppleMusicLibraryService.readLibrary()` |
| Per-artist rollup with plays, tracks, owned counts | `MusicLibrary.rollup` |
| "Played a lot and not supported" filter | `MusicLibrary.unsupportedArtists(in:supportedNames:minPlays:)` |
| Saving one artist from the Mac app | `SavedArtistsSync.saveArtist(slug:name:imageUrl:)` |
| Name → slug normalization | `artistSlug` in `api/functions/db.ts` |
| Name → artist page resolution | `resolveArtistPages` in `api/functions/collection-utils.ts` |

**New work:**

1. **`POST /api/me/library-scan`** (new function, added to `api/tsconfig.json`'s typecheck include
   and given a test in `api/functions/__tests__/`, following the `me-*` pattern).
   - Body: `{ artists: [{ name, playCount }] }`, authenticated bearer.
   - Resolves each name to an artist row, then returns **only** artists that have both an artist
     page and at least one link in a direct-support category — marketplace, patronage, or
     decentralized per `CATEGORY_ORDER` in `api/shared/platform-registry.ts`. Official-site and
     social links do not qualify; a Qobuz link does (see
     `feedback_qobuz_counts_as_direct_purchase`).
   - Respects admin link suppressions and 404-marked Bandcamp links — a suppressed link must not
     count as a support route.
   - Response per artist: `{ slug, name, imageUrl, platforms: [{ id, payoutPercent }], alreadySaved }`.
   - **Stores nothing.** No `listening_signals` write, no analytics row keyed to artist names. The
     request body is the whole input and it is discarded. This is what makes the privacy copy
     truthful without conditionals.
   - Rate limit: user-keyed, low ceiling (a scan is a deliberate act, a handful per day). Reuse
     `resolveAccountRequest`; do not put it in the shared `standard` bucket that the art proxy
     already contends for.
   - Chunk the resolution query — `.in()` over 1,778 names exceeds sane URL length, and PostgREST
     silently caps responses at 1,000 rows (`readAllPages` / chunked `.in()`).

2. **Payload shape decision.** 1,778 artist names is ~30KB — one request, no paging. Send names
   and play counts only. Do **not** send album titles, track counts, or cloud statuses; none of
   them affect the answer.

3. **Mac app: `LibraryScanView` + a small view model.** Holds scan state, the matched rows, and the
   selection set. Reuses `readLibrary()`; must not persist a `LibrarySnapshot` (delete the
   `appleMusicLibrarySnapshot` UserDefaults key on first run of the new version — an existing
   install may hold one from the removed feature).

4. **Ordering and cutoff.** Rank matched artists by play count. Apply a floor (`minPlays`), default
   proposed at **10** — from the measured distribution, 514 of 1,778 artists clear 10 plays and 961
   have been played at all, so a floor of 10 removes about half the noise without hiding anyone the
   user actually listens to. The cutoff is a product judgment; the measured numbers are in
   `project_support_loop_build_state`.

## Open questions for Brandon

1. **Floor**: 10 plays, or show everything matched and let sorting do the work?
2. **Does a match with no direct-support link deserve a mention?** The summary line above says "43
   more had pages but no direct-support link yet" — honest and mildly motivating, or noise?
3. **Should this also mark artists as supported?** Recommendation: no. Listening is not support,
   and the collection page's honesty depends on `purchased` meaning purchased.
4. **Existing uploaded rows.** Brandon's own `listening_signals` rows (1,778, from testing the
   removed feature) — delete them? `DELETE /api/me/listening` already exists and the removed UI's
   "Forget Imported Data" called it.

## Cleanup this spec implies

- `/api/me/listening` (POST/GET/DELETE) has no client once the import UI is gone. Keep the DELETE
  path until Brandon's rows are cleared, then decide whether the endpoint and `listening_signals`
  stay for a future gap report or come out. Do not leave it half-alive without a note.
- `MusicLibrary.rollup`'s totals don't sum: `subscriptionTotal` counts only `cloudStatus ==
  "subscription"`, so `unknown`/`removed` land in neither bucket (2,309 of 33,909 in the measured
  library). The scan doesn't display totals, so this stops being user-visible — but the
  `unknown → listened` mapping means **a user with iCloud Music Library switched off has every
  track read as a stream**. Irrelevant to the scan (it only needs names), so it is deliberately
  left alone here; revisit if provenance is ever displayed.
