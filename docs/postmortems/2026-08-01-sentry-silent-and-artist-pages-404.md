---
status: Done
---
# Sentry silently broken for 14 weeks, and 736 artist pages silently 404ing for 6.5 weeks

**Date:** 2026-08-01
**Severity:** Medium-high (zero error visibility for the entire life of the monitoring stack; ~93% of published artist pages returning 404 to fans, crawlers, and one social post)
**Status:** Resolved — all fixes merged same day
**Author:** Claude Code (this session); Brandon requested the postmortem after reviewing the fixes

## TL;DR

Two unrelated-looking bugs, discovered in the same session because fixing the first one required checking the second one would actually work. Neither was found by monitoring — both were found by *building* monitoring and then sanity-checking it against reality before trusting it.

1. **Sentry has reported zero events since it was added**, for two independent reasons: a CSP host mismatch that blocked every client-side event from the first day it was set up, and a server-side DSN that was simply never configured. Total time broken: **~14 weeks** (2026-04-24 → 2026-08-01).
2. **736 of 791 published artist pages (93%) have been returning 404** since a single refactor commit deleted a client-side data-fetch fallback without anyone tracing what depended on it. Total time broken: **~6.5 weeks** (2026-06-16 → 2026-08-01).

Both were fixed and merged the same day: PRs [#380](https://github.com/brandonlucasgreen/unstream/pull/380), [#382](https://github.com/brandonlucasgreen/unstream/pull/382), [#384](https://github.com/brandonlucasgreen/unstream/pull/384), [#385](https://github.com/brandonlucasgreen/unstream/pull/385).

## How this surfaced

Brandon shared `https://unstream.stream/artist/funkadelic` in a social post and clicked it himself — it 404'd. Searching "funkadelic" on the site worked fine, so the data existed; the page just wouldn't load it. That one click is the only reason either of these was found — nothing alerted on it.

---

## Incident 1 — Sentry: zero events, ever

### Timeline

| Date | Event |
|---|---|
| 2026-04-24 | `33c7595` — Sentry SDK added, client-side, via `VITE_SENTRY_DSN`. |
| 2026-04-24 (same day) | `7e6744f` — "fix CSP connect-src" adds `https://*.ingest.sentry.io` to `netlify.toml`. **This value is wrong** — see below. Not touched again until the fix, 14 weeks later. |
| 2026-06-07 | `ba74a74` (#256) — server-side Sentry added (`api/lib/sentry.ts`), reading `SENTRY_DSN`. Correctly designed as a no-op if unset. Nobody ever set it. |
| 2026-08-01 | Investigating the Funkadelic 404, Brandon asks why Sentry has never shown him anything. |
| 2026-08-01 | PR #382 fixes the CSP host. Brandon sets `SENTRY_DSN` himself (env writes are sandbox-blocked for the agent; confirmed via `netlify env:get` returning the real value rather than trusting the action happened). |

### Root cause

**Client side:** the DSN Sentry actually provisioned is `https://…@o4510896048242688.ingest.**us**.sentry.io/…` — a regional host. The CSP rule allowed `https://*.ingest.sentry.io`. CSP host wildcards are a **suffix match**, and `.ingest.sentry.io` is not a suffix of `.ingest.us.sentry.io`, so the browser silently blocked every outbound event. Proven directly in the browser rather than reasoned from the CSP spec:

```js
await fetch('https://o…ingest.us.sentry.io/api/…/envelope/', {mode:'no-cors'})  // BLOCKED: Failed to fetch
await fetch('https://o…ingest.sentry.io/api/…/envelope/',    {mode:'no-cors'})  // ALLOWED by CSP
```

No CSP violation appeared in the browser console for this — it went unnoticed because there was nothing to notice.

Likely origin of the typo: `apps/web/SENTRY_SETUP.md`, written the same day as the CSP rule, documents the DSN format with a **generic, non-regional example**: `https://x@o000000.ingest.sentry.io/000000`. The CSP rule reads like it was copied from that example pattern rather than checked against the actual, regional DSN that Sentry had provisioned. A one-token gap (`us.`) between the documentation's placeholder and the real value, and it was never re-checked.

**Server side:** simpler — `SENTRY_DSN` (distinct from `VITE_SENTRY_DSN`) was never set in Netlify at all. `api/lib/sentry.ts` was built defensively (no-op when the var is absent, so functions never crash without it), which is exactly why this was silent rather than a visible error. `netlify env:list` showed `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` present — someone had set up source-map uploads — but not the DSN that would let functions actually report anything.

**Net effect:** two independent single points of failure, both silent by design, compounding into exactly zero delivered events for the entire life of the integration. Neither failure depended on the other; either one alone would have produced the same symptom Brandon saw.

### Why this class of bug is easy to miss

A monitoring tool that has "always" reported zero looks identical whether it's working perfectly (no errors exist) or completely broken (no errors can get out). There's no negative-space signal — nothing tells you "this should have fired by now." The only way to catch it is to deliberately provoke an event and confirm it arrives, which nobody had done since setup.

### Fix

- `netlify.toml`: CSP host corrected to `https://*.ingest.us.sentry.io`, with the suffix-match reasoning left as an inline comment so it can't quietly regress the same way again.
- `SENTRY_DSN` set in Netlify (production), by Brandon — the agent's environment write access is sandbox-blocked, and the failure mode of that block is itself worth knowing: `netlify env:set` returns exit code 0 and prints nothing, indistinguishable from success unless you separately `env:get` to confirm.

This is also the **second time** a third-party telemetry tool on this site has silently reported zero because of a CSP host mismatch — Umami analytics hit the identical shape in 2026-04 (`api-gateway.umami.dev` missing from `connect-src`). The standing rule going forward: **a telemetry tool reporting exactly zero is a CSP hypothesis until disproven**, checked by comparing the tool's actual network host against the CSP `connect-src` list, not by reading the vendor's docs.

---

## Incident 2 — 736 of 791 artist pages returning 404

### Timeline

| Date | Event |
|---|---|
| 2026-02-07/08 | `data/artists/*.json` — hundreds of pre-generated artist pages committed (Wikidata-sourced, static). |
| 2026-03-14 | `7d83630` — v2.0 reorg; `persistSearchResults` introduced, opportunistically writing an `artists` row (unclaimed, `unverified`/`verified`) whenever a fan searches that artist. Unrelated to the static files; runs independently. |
| ~2026-05-15 (confirmed by `db83f66`, likely earlier) | `ArtistPage.tsx` tries pre-generated static JSON **first**, with the database as a fallback for claimed artists lacking a static file. The static-file fetch is the load-bearing path for every unclaimed artist. |
| 2026-06-14 | `d209840` (#272) — `/api/artist-page` added: a new, richer endpoint, but scoped **only to claimed profiles** — correct for its stated purpose at the time, since nothing else used it yet. |
| 2026-06-16 | **`9badcc7` (#274) — the regression.** `ArtistPage.tsx` rewritten as a "thin shell" calling `/api/artist-page` exclusively. This deleted the client-side fallback fetch to the static JSON files, without anyone tracing that the fallback was the only thing rendering unclaimed artists. |
| 2026-06-16 onward | Every unclaimed artist page begins 404ing. Two different symptoms, silently, from this point forward: |
| | — An artist someone happens to **search** afterward gets a row via `persistSearchResults`, but hits the claimed-only filter in `/api/artist-page` → 404 anyway. |
| | — An artist nobody searches gets **no row at all** and no fallback to catch it → 404. |
| 2026-08-01 | Brandon's Funkadelic social-post click surfaces the first symptom. PR #380 removes the claimed-only filter. |
| 2026-08-01 | Building a "we 404'd a URL we publish" Sentry signal (PR #382) means checking it would actually fire — auditing `data/artists-manifest.json` against the database surfaces the second, much larger symptom: **only 55 of 791 published slugs had a database row at all.** |
| 2026-08-01 | PR #384 backfills the missing 736 artists + 4,786 links from the orphaned static files into Supabase (insert-only; claimed artists provably untouched). PR #385 makes the sitemap stop advertising slugs with no row, and bases `lastmod` on real database change dates instead of the static file's generation date. |

### Root cause

**This is one regression, not two.** Commit `9badcc7` (PR #274, "rewrite ArtistPage as thin shell with three render branches") replaced a multi-step client-side data-fetch cascade with a single call to the new `/api/artist-page` endpoint. The old code's own comment names exactly what was lost:

> `// API returned nothing — try pre-generated JSON as fallback (covers artists from the Wikidata dataset who haven't yet claimed a profile).`

`/api/artist-page` had been built two days earlier for a narrower purpose (serving claimed profiles) and was never a superset of what it replaced. The refactor's mental model was "consolidate the page's data sources into one API call" — reasonable on its face — but the fallback it swept away was a plain client-side `fetch()` to a static file, living entirely in the frontend. It never appeared in any grep of the backend code the refactor touched, so nobody traced it as a dependency before deleting the component around it.

From that day, the ~791 published artists split into two populations, both broken, for different visible reasons:

- **Artists who got searched afterward** (confirmed: the 55 pre-existing database rows have `created_at` dates clustering 2026-05-29 through 2026-07-30 — squarely the plausible search-traffic window after the regression) picked up a row via the unrelated `persistSearchResults` path, then hit `/api/artist-page`'s claimed-only filter and 404'd. This is the Funkadelic class — fixed by removing that filter (#380).
- **Artists nobody happened to search** (736 of them) had no row and no fallback left to catch the gap. Their static files sat on disk the entire time, still linked from the sitemap and from generated social posts, 404ing for anyone who clicked. Fixed by backfilling real rows from those static files (#384) and updating the sitemap to never again advertise a slug with no data behind it (#385).

### Why this went unnoticed for 6.5 weeks

- The 404 was a **normal response on both sides of the fetch** — `ArtistPage.tsx` treats a 404 from `/api/artist-page` as "this artist doesn't exist" and shows the ordinary not-found card; the endpoint returns a plain 404 with no error logged anywhere. There was nothing for Sentry to have caught even if Sentry had been working (see Incident 1) — generic error monitoring cannot distinguish "artist genuinely doesn't exist" from "artist we ourselves published."
- The sitemap and the social-post generator both read `data/artists-manifest.json` directly and had no way to know the page behind those URLs had stopped resolving — they kept confidently advertising all 791.
- Nothing measures 404 rate against "URLs we ourselves publish" as a distinct category from "URLs someone guessed" — which is precisely the gap PR #382's new signal closes.

### Fix

- **#380** — removed the claimed-only filter from `getArtistProfileBySlug`, and made the endpoint apply the same claimed test (`match_confidence === 'claimed' AND profile.verified_at`) the crawler-facing edge function already used, so the two renderers of `/artist/:slug` can't disagree about which card a fan sees.
- **#384** — backfilled 736 `artists` rows + 4,786 `artist_links` from the orphaned static files. Insert-only (existing/claimed rows untouched, verified via `source='claimed'` count unchanged at 124 before and after); the slug was taken from the manifest rather than re-derived from the artist name, because the derivation function disagrees with the manifest's slug on 34 of 791 artists (accent-stripping: `Jónsi` → `j-nsi`) — reusing it would have silently filed those 34 under URLs the sitemap doesn't even advertise.
- **#382** — added a signal that reports a 404 specifically when the slug is one in `data/artists-manifest.json` (deduped per slug per 24h so it doesn't flood), and separately made a *failed* database lookup return 503 rather than 404 — previously a Supabase outage would have rendered as every artist page confidently reporting the artist doesn't exist, which is a monitoring signal that lies.
- **#385** — sitemap `lastmod` now comes from `artists.updated_at` instead of the static file's generation date, and a manifest slug with no database row is omitted from the sitemap rather than advertised.

---

## What went wrong, generalized

Both incidents are the same shape, one layer apart:

1. **A refactor assumed a new component was a superset of the old one, without tracing every consumer of the surface being replaced.** For Sentry, the "same" DSN pattern from generic setup docs replaced a check against the real, regional value. For the artist pages, a new backend endpoint replaced an entire client-side fetch cascade, including a fallback that lived outside the code being reviewed.
2. **Both failures were silent by design**, and that design choice was individually correct — a monitoring SDK should no-op rather than crash when unconfigured; a "not found" page should render calmly rather than error. But "fail quietly" only works if something else is watching for the quiet failure, and nothing was.
3. **Neither was caught by testing.** Both shipped, deployed cleanly, and passed whatever checks existed at the time — because both are absence bugs (a resource that stopped existing, a channel that stopped delivering), and absence doesn't fail loudly on its own.

## What went well

1. **Checking the monitoring signal against reality before trusting it** is what actually found the 736-page outage — a much bigger problem than the one being investigated. Building the "404 on a published slug" alert meant asking "would this fire today?", and auditing the manifest against the database answered that question with a number nobody had measured before.
2. **Verification was done by proof, not by inference**, throughout: the CSP block was demonstrated with a live paired fetch on production, not reasoned from the spec; `SENTRY_DSN`'s absence was confirmed via `netlify env:list` rather than assumed from the code; the backfill was dry-run first, then run on 3 artists and checked live, then run in full; the combined merge of two PRs touching the same file was built and tested locally before either was merged, not just trusted from green CI checkmarks.
3. **The fix stopped at the actual scope of the problem.** The backfill is insert-only and explicitly does not touch claimed artists, does not trigger release cataloguing for 791 artists at once (that's a deliberate follow-up, not bundled in), and does not derive slugs in a way that could silently miss the 34 accent-mismatched artists.

## Cost

- Zero error visibility for ~14 weeks (2026-04-24 → 2026-08-01) — an unknown number of other silent failures in that window were never reported and cannot be reconstructed now.
- 736 of 791 published artist pages (93%) returning 404 for ~6.5 weeks (2026-06-16 → 2026-08-01) to fans, to search crawlers, and to at least one social post that had already gone out before the bug was found.
- No data loss — the underlying static data was intact the whole time under `data/artists/`, which is what made the backfill possible without re-fetching anything from Bandcamp or elsewhere.

## Follow-ups (open as of this postmortem)

1. **Catalogue releases for the 736 backfilled artists.** All 736 have Bandcamp links; their pages currently show platform links but no releases, which is the main quality gap left. Deliberately not triggered by the backfill itself — doing so would have queued hundreds of Bandcamp crawls in one run. Needs batching over several days.
2. **The `artistSlug()` accent-stripping mismatch** (34 of 791 manifest entries) is flagged but not yet investigated as a live bug in the search path — unclear whether it has produced any bad rows via `persistSearchResults` for artists with accented names searched directly (as opposed to through the backfill, which used the correct manifest slug throughout).
3. **Claimed-artist empty links — open bug** (tracked in Claude Code session memory as `project_claimed_artist_empty_links`, no doc in this vault yet), adjacent to this incident: claiming a profile can currently delete an artist's existing fan-out links, making their page worse rather than better. More exposed now that 736 more artists have links worth losing.
4. **Search Console — "Validate fix"** on the 404 report for `/artist/*` URLs, once #385 is live, to ask Google to re-crawl in bulk rather than wait for its own schedule.

## Cross-references

- PR #380: https://github.com/brandonlucasgreen/unstream/pull/380
- PR #382: https://github.com/brandonlucasgreen/unstream/pull/382
- PR #384: https://github.com/brandonlucasgreen/unstream/pull/384
- PR #385: https://github.com/brandonlucasgreen/unstream/pull/385
- Regression commit: `9badcc7` (#274, 2026-06-16)
- Original CSP bug commit: `7e6744f` (2026-04-24)
- Session memory: `project_sentry_never_delivered.md`, `project_orphaned_static_artist_pages.md`, `project_artist_page_two_renderers_fix.md`, `feedback_ssr_to_spa_endpoint_scope.md`, `feedback_umami_csp.md`, `reference_netlify_env_list.md`, `project_sitemap_lastmod_accuracy.md` — all in the Claude Code memory store for this project, cross-linked to each other.
