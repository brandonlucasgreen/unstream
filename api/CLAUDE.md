# api/ — backend code

Read this with the root `CLAUDE.md`, which holds the rules for every change (security practices, never cache uncertainty, testing, deployment). This file covers what the folders under `api/` share. Two of them have files of their own:

- `api/functions/CLAUDE.md` — the Netlify functions, **the live backend**: search flow, Redis, middleware, auth, releases, collections, tips.
- `api/edge/CLAUDE.md` — the Deno edge functions that render pages for crawlers and the release page.

## What is where

- **`api/edge/`** — `og-metadata`, `artist-page-static`, `release-page`, `noscript-search`, `u-handle`, `static-page-meta`. **`api/search/`** — `bandcamp-probe.ts`, `enrichment.ts` and `commons-photo.ts`, imported by the functions (the search endpoints themselves live in `api/functions/`). **`api/shared/`** — code both Node and Deno (or Node and the web client) import, e.g. `platform-registry.ts`, `bandcamp-identity.ts`, `artist-bio.ts`, `crawler-detection.ts`, `release-display.ts`, `desktop-release.ts`. **`api/lib/`** — `resend.ts`, `sentry.ts`, `reserved-handles.ts`, `excluded-artists.ts`, `non-artist-names.ts`.

Shared files with a rule written up somewhere else:

- `api/shared/bandcamp-identity.ts` — "same name, different Bandcamp account" and its three copies: `api/functions/CLAUDE.md`, "Search flow".
- `api/shared/release-display.ts` (`oneSourcePerPlatform`) — `api/functions/CLAUDE.md`, "Release dedup".
- `api/shared/tips.ts`, `api/lib/production-site.ts` — `api/functions/CLAUDE.md`, "Artist patronage (tips)".
- `api/lib/internal-origin.ts` — `api/functions/CLAUDE.md`, "Auth on the server".
- `api/shared/edge-context.ts`, `site-chrome.ts`, `platform-logos.ts`, `guessed-slug.ts`, `crawler-detection.ts` — `api/edge/CLAUDE.md`.
- `api/shared/html.ts` (`escapeHtml`) — root `CLAUDE.md`, "Security practices".
- `api/lib/sentry.ts` — `api/functions/CLAUDE.md`, "What is here".

## Typecheck coverage

**Typecheck coverage: everything, by default.** `api/tsconfig.json` includes `functions/*.ts`, `functions/db/*.ts`, every test in `functions/__tests__/`, and `shared/`, `lib/` and `search/`, so a new function or test is checked under strict mode by existing. It has no `exclude` list: the 19 older tests that once sat on one were fixed on 2026-11-16, and a test never goes back on one. A test that reads a handler's response wraps the call in `answered()` (`__tests__/answered.ts`), since a handler is typed as possibly returning nothing; a mock that stands in for a `db` function is typed as that function (`ReturnType<typeof import('../db').getArtistBySlug>`), so a fixture that drifts from the real type stops compiling. `scripts/tsconfig.json` holds `scripts/` to the same settings: those scripts run unattended in the build and in Actions, and until 2026-11-16 nothing checked them. The edge functions in `api/edge/` import from URLs (`esm.sh`, `edge.netlify.com`) that only Deno resolves, so `tsc` can't see them; `npm run typecheck:edge` (`deno check`) can, and the `edge-typecheck` job in `ci.yml` runs it. It isn't in `npm run verify`, which has to work without Deno installed, so **run it yourself after touching `api/edge/` or anything in `api/shared/` an edge function imports.**

## Running `npm run dev` from a worktree

**A worktree serves the main checkout's functions.** Worktrees under `.claude/worktrees/` sit inside the main repo, and netlify-cli finds its root by looking for a `.git` *directory* — a worktree's is a file — so `npm run dev` there builds `api/functions/` from the main checkout. A new function answers `Function not found...`; an edited one quietly runs the old code. Pass the worktree's own folder: `npm run dev -- --functions "$PWD/api/functions"`, and check that `.netlify/functions-serve/<name>/<name>.js` requires `./api/functions/…`, not an absolute path into the main checkout. Edge functions still come from the main checkout and there's no flag to move them, so edge work needs the main checkout (or, for the release page, `preview:release`).

What a worktree needs copied in, and the other local-dev traps, are in the root `CLAUDE.md`, "Local dev".

## Platform registry

`api/shared/platform-registry.ts` is the single source of truth for platform metadata: name, color, icon, category (marketplace, patronage, decentralized, library, official, social), payout percentage, AI policy, `CATEGORY_ORDER`. Add or change platforms there rather than hardcoding elsewhere, then check for stale copies:

```bash
grep -r "PLATFORM_INFO" api/edge/ apps/web/src/
```

`apps/web/src/services/sources.ts` mirrors the registry by hand (it isn't derived from it, and has drifted before) and adds client-only fields (description, `searchUrlTemplate`, `hasEmbed`, `searchOnly`). Keep the shared fields in sync. That grep doesn't find the other hand-kept tables, which need the same change: the extension's `apps/extension/lib/constants.js`, the Mac app's `Models/PlatformCatalog.swift`, and `api/functions/platforms-list.ts` (behind `/api/v1/platforms`). `platform-registry-copies.test.ts` fails when `sources.ts`, the extension or the Mac catalog disagrees with a registry payout or is missing one; a Mac or extension fix reaches users only with that app's next release.

## Bandcamp discovery by subdomain probing

`bandcamp.com/search` is behind a Fastly bot challenge and `Disallow`ed in robots.txt, so it cannot be used. `api/search/bandcamp-probe.ts` derives candidate slugs from the query and requests `<slug>.bandcamp.com/music` (robots-permitted), resolving identity (`data-band`), release counts, location, titles and photo in one request per candidate.

**Verify both identity and substance.** A slug existing doesn't mean it's the right artist; a name matching doesn't mean it's a real presence — parked, empty accounts match `beyonce`, `sufjan`, `jackwhite`. Verdicts: `accepted`, `absent`, `rejected_empty`, `rejected_name`, `undecided`.

**The probe can only find a subdomain derived from the name.** An account like `honeycrush-online` (Honeycrush, Brooklyn) is reachable only through a link: MusicBrainz's Bandcamp relation, or — when that is missing or retired — a Bandcamp link on the artist's own official site or Linktree, accepted only if the subdomain carries the artist's name (`pickArtistBandcampUrl`) and isn't retired.

Outcomes — **including negatives** — are cached in `bandcamp_slug_probes` (migrations `20260726120000`–`20260726220000`, `20260727090000_bandcamp-probe-probed-slugs.sql`, `20260727120000_bandcamp-probe-clear-false-empty.sql`, `20260930120000_bandcamp-probe-bio.sql`). The `probed_slugs` column records which slugs were actually tried, so a cached negative can't hide an artist whose name has a hyphen.

The rule this cache is built around, "Never cache uncertainty", is in the root `CLAUDE.md`.

## Artist bios

A search or detection result carries one `bio` (`{ text, source, sourceUrl, truncated }`), picked **on the server** by `api/shared/artist-bio.ts` in this order: claimed profile → Bandcamp sidebar → Discogs profile → Wikipedia (via MusicBrainz's Wikidata relation). Clients only render it, as plain text, and label the source by platform (no source line at all for a claimed bio, whose card already links to the artist's page). Spec: `docs/specs/artist-bio-excerpt-spec.md`. Four rules:

- **`artist_profiles.show_bio = false` means no bio at all**, not a fallback. It shows up on the card as `bioSuppressed`, and clients never fill a claimed card from Phase 2.
- **Phase 2 fills a gap, never replaces.** Phase 1's sources outrank Phase 2's, and a fill requires an exact name match.
- **`bandcamp_slug_probes.bio`: `''` means checked-and-empty, `NULL` means never checked.** Keep the two distinct.
- **A bio source that didn't answer is not "no bio".** `bioFetchFailed` keeps that result out of the long cache.
