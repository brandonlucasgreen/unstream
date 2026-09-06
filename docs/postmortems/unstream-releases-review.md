---
status: Done
---
# Unstream Releases — spec pressure test + review of PR #336

**Reviewed:** 2026-07-29
**Inputs:** `music-sindy-spec.md` (Unstream Releases feature spec, 2026-07-28), PR [#336](https://github.com/brandonlucasgreen/unstream/pull/336) `feat/releases`
**Verdict:** don't merge #336 as-is. The migration is close to right; the application code has verified correctness bugs and puts writes on the search hot path. Separately, the spec's Phase 1 builds the headline features on data that doesn't support them — and the data that *would* support them is already being fetched and cached today.

> ## Status: PAUSED — 2026-07-29
>
> Brandon paused the feature the same day this review landed, for two reasons:
>
> 1. **The cost of deduplication.** Going after real discographies (the right call — see Part 2B)
>    promotes cross-source dedup from a §15 footnote to the main body of work.
> 2. **The premise in §1 is wrong. Odesli is not dead.** The spec opens with "Odesli
>    (song.link) *is now dead/acquired by Musixmatch*" and treats that as the void this
>    feature fills. In fact only Odesli's **public API** was shut down — the product is live
>    and artists are still using it. So there is no vacuum to fill and no time pressure.
>
> That second point is the load-bearing one and it invalidates the urgency, not the idea.
> Release chronology and direct-support-first release pages are still differentiated
> (Odesli routes to streaming; Unstream's whole thesis is routing away from it). But it's a
> *want*, not a *gap*, and it should be picked back up on its merits rather than to beat a
> competitor that never left.
>
> **One carve-out must not pause with the feature:** the `check-releases` SSRF and
> rate-limit fix. That is a live exposure on `main` today, independent of Releases. See
> "The one thing to ship anyway" at the end of Part 3.
>
> Before restarting, re-read Part 2 — the phasing in the spec is wrong in a way that is
> cheap to fix on paper and expensive to discover in code.

---

## Part 1 — PR #336

### State of the branch

| | |
|---|---|
| Files | 6 (`check-releases.ts`, `db.ts`, `release-utils.ts` (new), `scripts/migrate-releases.ts` (new), migration 029, `schema.sql`) |
| Size | +673 / −9 |
| Tests added | **0** |
| Merge status | `CONFLICTING` — trivial import conflict in `db.ts`, but 12 commits behind `main` |

**Things that are *not* problems** (so nobody re-chases them):

- The `jose` module error is a stale local `node_modules` — `jose@^6.2.4` is declared in `dependencies` and installs fine in CI. Not a code issue.
- The out-of-order migration timestamp (`20260728120000` behind `main`'s `20260729130000`) is safe: `.github/workflows/supabase-migrate.yml` passes `supabase db push --include-all`, which applies out-of-order versions. Worth renaming for tidiness, not a blocker.
- **No new type errors.** Typechecked the four changed/new `api/` files against a strict config: the only error is `mirloRssCache` possibly-null, which reproduces identically on `main`. (Remember `api/tsconfig.json` only covers the `me-*` files, so this had to be checked manually.)
- **No test regressions.** 87 API tests pass on the branch.

### Blocking findings

#### 1. The rate limit silently breaks release notifications in both shipped clients

`check-releases.ts` gains `checkRateLimit(ip, 'strict', ...)` — 10 req/min, 500/day. But both clients call this endpoint **once per artist in a sequential loop with no delay**:

- [`apps/extension/background/service-worker.js:552`](apps/extension/background/service-worker.js:552) — `for (const artistName of artistNames)` over every saved artist, weekly.
- [`apps/mac/Unstream/ReleaseAlertManager.swift:203`](apps/mac/Unstream/ReleaseAlertManager.swift:203) — `for entry in entries` over every supported artist.

Both swallow the error (`console.error` / `print`) and move on, and both then commit `lastCheckDate` / known-release state regardless. So a user tracking more than ~10 artists loses release alerts for everyone past the 10th, silently, until the next weekly run — which fails the same way. This is the exact "silent source failure" class the codebase has been fighting.

The endpoint genuinely is expensive and does need a limit. The fix is not just a bigger number:

- Add a **batch shape** — `{ artists: [{ artistName, platforms }] }`, capped at N — so one client sweep is one request. That's the right primitive for a per-artist-loop client anyway.
- Until clients ship that, use the `lenient` tier and have both clients **stop on 429 and reschedule** instead of burning through the remaining artists and marking the run complete.

This should ship as its own PR. It's a fix to a live feature and shouldn't be gated behind a data-model feature.

#### 2. The slug collision "hash" is not a hash, and doesn't fix the collision it was written for

`release-utils.ts`:

```ts
const hash = Buffer.from(title).toString('hex').slice(0, 6);
return `${base}-${hash}`;
```

`.slice(0, 6)` of a hex string is the **first three bytes of the title**, not a digest. Verified:

```
Album Name.  ->  album-name-416c62
Album Name!  ->  album-name-416c62
Album Name?  ->  album-name-416c62
```

All three collide with each other. And titles differing only in trailing punctuation are *precisely* the case the comment says it exists to handle. Use `createHash('sha1').update(title).digest('hex').slice(0,6)` (`crypto`, per the Node-18 rule — not `crypto.subtle`), or the UUID fallback the spec actually specified (§8: "Collision fallback: UUID").

#### 3. Non-Latin titles are silently dropped; accents are deleted, not folded

`releaseSlug` / `normalizeReleaseTitle` do a bare `replace(/[^a-z0-9]+/g, '-')`. Verified:

```
"Björk"              -> "bj-rk"
"Sigur Rós - Takk..." -> "sigur-r-s-takk"
"東京"                -> ""      ← empty
"Привет"             -> ""      ← empty
"Ⅱ"                  -> ""      ← empty
```

Empty normalized title hits `if (!norm) continue` in both `db.ts` and `migrate-releases.ts` — so **any release with a CJK, Cyrillic, Greek, or Arabic title never enters the catalog at all**, with no log line. For an indie-music product that's a real coverage hole, not an edge case.

There is already a correct helper for this: `normalizeForComparison` in `search-utils.ts`, which NFD-folds accents rather than deleting them. Slugs need an NFKD fold plus a transliteration or hash fallback for scripts that fold to nothing.

#### 4. The upsert overwrites good data with null

Both write paths do a blind upsert:

```ts
release_date: releaseDate,   // may be null
artwork_url: artwork,        // may be null
```

Search N discovers the release via Bandcamp with artwork and a date. Search N+1 runs while Bandcamp is slow, only Mirlo answers, no artwork or date — and the upsert on `(artist_id, slug)` **replaces the stored artwork and date with NULL**. This is "never cache uncertainty" in write form: an absent field from a partial fetch is being treated as an authoritative "this release has no artwork".

Fix: read-then-merge, or move the write into a Postgres function using `COALESCE(excluded.artwork_url, artist_releases.artwork_url)`. The latter is cleaner and also removes a round trip.

#### 5. Within-batch collisions still clobber

`existingTitlesBySlug` is fetched once per artist *before* the release loop and never updated as rows are inserted. Two new titles that slug identically in the same run both get the bare slug; the second upsert overwrites the first. Add each slug to the map as it's used.

#### 6. Release writes are on the search hot path

`persistSearchResults` is `await`ed at [`search-sources.ts:2035`](api/functions/search-sources.ts:2035), before the response is assembled — not fire-and-forget (correctly, since un-awaited work dies when Lambda freezes). The PR adds, per artist result: 1 `SELECT`, then per release 1 upsert+select, then per platform 1 upsert — all sequential.

At ~5 results × 1 release × 2 platforms that's roughly 20 extra sequential Supabase round trips per search. At 30–80 ms each, 0.6–1.6 s added to every search, after a long run of work to get prod down to ~1.8–3.0 s. The PR body calls this "negligible" and "fire-and-forget"; it is neither.

Release ingest doesn't belong in the search request at all — see the Part 3 recommendation.

#### 7. The SSRF fix is right, but it breaks self-hosted Faircamp

Adding `isUrlHostnameAllowed()` to `check-releases` closes a real open-proxy hole — good, and it should ship. But `middleware.ts` only admits Faircamp URLs where `faircamp` appears as a non-leftmost domain label. Real Faircamp is self-hosted on arbitrary domains (`music.someartist.com`), so most genuine Faircamp URLs will now 400. Combined with finding #1, Faircamp release checking effectively stops working.

`checkFaircamp` needs a different containment story than a hostname allowlist — a stored-URL check (only fetch URLs already persisted in `artist_links` for that artist) gives the same SSRF guarantee without an allowlist. Decide this deliberately; don't let it regress silently.

#### 8. `is_streaming` contradicts the platform registry, and a third of its ids don't exist

```ts
export const STREAMING_PLATFORMS = new Set([
  'spotify', 'applemusic', 'apple_music', 'tidal',
  'qobuz', 'beatport', 'hoopla', 'freegal',
]);
```

`spotify`, `applemusic`, `apple_music`, and `tidal` are not platform ids in `api/shared/platform-registry.ts` — Unstream doesn't index them. And `beatport` is `category: 'marketplace'` with a payout percentage; `hoopla`/`freegal` are `library`. Marking them `is_streaming: true` contradicts the registry, which CLAUDE.md names as the single source of truth.

Also: `is_streaming boolean not null default true` defaults the wrong way for a catalog that is overwhelmingly non-streaming.

Drop the boolean. Derive from `PLATFORMS[id].category`, which already encodes marketplace / patronage / decentralized / library / official / social — strictly more information than a boolean, and one place to maintain.

#### 9. No tests

`release-utils.ts` is a pure module with no HTTP, cache, or DB dependency — explicitly modelled on `search-utils.ts`, whose whole point is that it's unit-testable. Zero tests were added. Findings #2, #3, and #5 above would all have been caught by about fifteen lines of test.

#### 10. Two identical functions, plus a comment defending a distinction that doesn't exist

`releaseSlug` and `normalizeReleaseTitle` produce byte-identical output for every input tested — the `.trim()` the comment says prevents "normalization drift between the migration script and the live pipeline" is dead, because `[^a-z0-9]+` already consumes whitespace and `^-|-$` strips the edges. Two names, one behavior, and a load-bearing-sounding comment asserting otherwise.

Keep one function.

### Smaller items

- `schema.sql` and migration 029 **disagree** on `release_links.source`: the migration says `'auto' | 'claimed'` with provenance in the `platform` column; `schema.sql` says `'auto' | 'claimed' | 'bandcamp' | 'mirlo' | 'musicbrainz' | 'itunes'`. Neither has a `CHECK` constraint (unlike `release_type`, which does). Pick one, add the constraint.
- `musicbrainz_id` is indexed but not unique, while the spec calls it "the canonical key". Add `unique(artist_id, musicbrainz_id)` where non-null.
- `check-releases.ts` imports `'./middleware.js'`, `'./release-utils.js'`, `'./ratelimit.js'` with `.js` extensions. Every other import in `api/functions/` (100+) is extensionless. Likely resolves through esbuild, but it's an untested deviation on a path that isn't typechecked.
- `releaseType` is added to the `check-releases` response and computed via `bandcampReleaseType`, but nothing consumes it — the persistence that would have used it was removed in commit 2. The PR body still describes that removed persistence ("check-releases.ts — now persists detected releases … fire-and-forget"). Either wire it up or drop it.
- `mapReleaseType` can only ever return `'album'` or `'single'`; `'ep'` and `'compilation'` are unreachable in every current code path.
- Date parsing is copy-pasted verbatim between `db.ts` and `migrate-releases.ts` — ~25 lines, in a PR that created a shared pure-utils module for exactly this.
- `new Date("December 6, 2024").toISOString().split('T')[0]` parses as local midnight and formats as UTC. On a UTC+ machine that returns the *previous* day. Netlify runs UTC so the function path is fine; the migration script runs on whatever laptop invokes it.
- Missing newline at EOF in `release-utils.ts`, `migrate-releases.ts`, and the migration. Stray indentation on the `idx_artist_releases_musicbrainz_id` line in `schema.sql`.

---

## Part 2 — pressure testing the spec

The spec is well-reasoned about *why* this belongs in Unstream (§3 is genuinely convincing) and about scope discipline. Two problems, one of which only surfaced after the review was first written.

**The premise is wrong (§1).** "Odesli (song.link) solved cross-platform link resolution but is now dead/acquired by Musixmatch" — only the **public API** was retired. The product is live and artists still use it. Since §1 is what establishes urgency, correcting it removes the urgency: this is a want, not a gap. It doesn't invalidate the idea (Odesli routes *to* streaming; Unstream's thesis is routing away from it, so a direct-support-first release page is still differentiated) but it does mean the feature should be picked up on its own merits and its own timeline. This is why the feature is paused.

**The phasing is wrong.** Independently of the above: **Phase 1's data source can't carry Phase 3 and Phase 4's features.** This is the part that's cheap to fix on paper and expensive to discover in code, so it's worth reading before any restart.

### A. V1 has no chronology, because `latest_release` holds one release

`artist_links.latest_release` is, by definition, the single most recent release per platform. So on the day this ships:

- §7 "Releases section — chronological list of releases, newest first" is a list of length 1 for essentially every artist.
- §9 "RSS feed — one entry per release, newest first" is a one-item feed.
- "Subscribe once and never miss a drop" is being offered on top of a feed whose only entry is the release the fan has, by definition, already seen.
- The ICS calendar has one all-day event in the past.

The table does accumulate forward — each new distinct latest-release title adds a row — so chronology grows from launch day onward, but only for artists someone happens to search, and it will take quarters to look like a discography. Shipping the feed UI on top of that risks the feature's one moment of first impression.

This is the single biggest thing to fix before building Phases 3–4.

### B. The full catalog is *already being fetched and cached*

The spec defers full discography to Phase 5 / V2 as if it were expensive. It mostly isn't:

- `api/search/bandcamp-probe.ts` already requests `<slug>.bandcamp.com/music` — the artist's **complete** release grid — for every Bandcamp artist, and the response is already cached in `bandcamp_slug_probes`.
- `parseBandcampReleaseTitles` ([search-parsers.ts:297](api/functions/search-parsers.ts:297)) already walks `.music-grid-item` and stores **up to 20 release titles** in `bandcamp_slug_probes.release_titles`.
- `parseBandcampSidebarDiscography` already extracts `{ href, title }` pairs from the `#discography` layout.

Two gaps, both small: the grid parser throws away the `href` and passes titles through `normalizeForComparison` (match-quality, not display-quality), and neither parser reads artwork or date — which are in the same DOM node it's already inside.

So "capture the real Bandcamp catalog" is a parser change plus columns, against HTML already in hand, for zero additional requests to Bandcamp. Compare that to Phase 1 as written — a migration script, a hot-path write, and a one-release-per-artist result. **The cheap path produces strictly better data than the specced path.**

**Mirlo is better than the spec assumed — verified live 2026-07-29.** The spec proposes
"Mirlo RSS" for full catalog, but the RSS endpoint already in use
(`api/mirlo.space/v1/trackGroups?format=rss`, `check-releases.ts:215`) is a *global*
recent-releases window across the whole platform, not a per-artist discography. The right
endpoint is the one `enrichment.ts:608` already calls for location:

```
GET https://api.mirlo.space/v1/artists/<urlSlug>   →   result.trackGroups[]
```

That returns the artist's **complete** discography in a single request. Verified against
two live artists: 5 and 24 trackGroups respectively, each carrying `title`, `releaseDate`,
`urlSlug` (→ the release URL), `type`, `publishedAt`, and `cover`. Already covered by the
`*.mirlo.space` SSRF allowlist entry. This is a day of work, not a scraping project.

Two data-hygiene notes from that same check: `releaseDate` is frequently `null`, and one
artist had entered **`2925-11-02`** — a typo'd year that will sort to the top of every
chronology and land in every ICS calendar. Sanity-bound release dates on ingest
(reject outside, say, 1900 → today + 3 years) regardless of source.

Recommendation: **delete the `latest_release` → `artist_releases` lift entirely.** It's the source of the thin data, it's the source of most of PR #336's complexity, and the catalog capture supersedes it. If a floor is wanted, run the lift once as a backfill and never wire it into the request path.

### B2. The cost of going this route: dedup becomes the main body of work

Worth stating plainly, because it's the reason the feature was paused. With one release per
artist, dedup is trivial. With ~20 titles from Bandcamp, up to ~24 trackGroups from Mirlo,
and MusicBrainz release groups on top, you are matching titles across sources **with no
shared identifier for most indie artists** — and Bandcamp/Mirlo overlap heavily for exactly
the artists who use both. Titles won't match cleanly: `(Remastered)`, deluxe editions,
singles later folded into an album.

Two things make it tractable, and both should be used rather than falling back on fuzzy
title matching alone:

- **Match within release type, not across it.** Mirlo's `type` field and Bandcamp's
  `/album/` vs `/track/` path both give a real type. `mapReleaseType` in #336 collapses
  everything to album-or-single and can never emit `ep` or `compilation`; that throws away
  a signal worth keeping.
- **Use `normalizeForComparison` from `search-utils.ts`**, which NFD-folds accents instead of
  deleting them — the pipeline already has a correct normalizer and #336 hand-rolled a
  broken one (Part 1, finding #3).

§15 rates this "Medium / Medium". On the catalog path it is the single largest line item.

### C. ICS-for-upcoming — the most compelling hook — *does* have a data source (corrected)

§4, §6, and §9 all lean on upcoming releases ("**Especially useful for upcoming releases**",
"fans can see future release dates in their calendar"). My first read of this was that
nothing in the V1 or V2 pipeline captures a future date, and that the framing should be
dropped. **That was wrong — Mirlo carries future release dates.**

Verified live 2026-07-29 against `api.mirlo.space/v1/artists/<slug>`: one artist's
discography contains releases dated **`2027-09-07`** and **`2026-07-14`**, i.e. genuinely
forward-dated against a 2026-07-29 "today". Mirlo artists schedule releases and the date is
exposed in the same `trackGroups` payload as everything else. So the ICS calendar — the most
compelling pitch in the spec — is reachable in V1 for Mirlo artists at no extra cost beyond
the catalog fetch itself.

Still true, and still needs doing:

- **The data model has no announced-vs-released distinction.** Add a status or
  `is_upcoming` derivation; a chronology that silently mixes future and past releases in one
  "newest first" list reads as broken.
- **Bandcamp pre-orders are not captured.** Bandcamp surfaces them on `/music` in the same
  DOM node the parser already stands in, so this is cheap — but it is a separate change from
  the Mirlo path.
- **MusicBrainz and iTunes skew to already-released** and shouldn't be relied on here.
- **Sanity-bound the dates** (see B) — a typo'd `2925` release date pushed into a fan's
  calendar is a worse failure than no calendar.

### C2. iTunes and MusicBrainz should enrich, never discover

iTunes is the odd source out, and not on cost — `itunes.apple.com/search` is free and
unauthenticated (see §H). The problem is mission.

iTunes returns no direct-support links. So any release it *discovers* that isn't also on
Bandcamp or Mirlo produces a release page whose only outbound link is Apple Music — on a
product that exists to route listeners away from streaming. That page argues against itself,
and at scale it turns the release catalog into a streaming directory with Unstream branding.

§4 already gestures at this ("Use for populating release entities, not for link resolution").
Make it a hard rule and apply it to MusicBrainz release groups too:

> **A release enters the catalog only via a direct-support source (Bandcamp, Mirlo, Faircamp,
> Ampwall, …). iTunes and MusicBrainz may only enrich releases already present** — dates,
> types, artwork, MB release-group id for dedup.

Cost of the rule: some real releases are missed. Benefit: every release page in the catalog
has at least one direct-support link, which is the only version of this feature consistent
with the product. It also makes the `noindex` quality bar in (E) largely redundant, and it
shrinks the dedup surface (B2) by keeping the two sparsest, least-matchable sources out of
the discovery path.

Worth noting these two are strongest exactly where Bandcamp and Mirlo are weakest — the
bigger names among the ~790 pre-generated SEO artists. That's a genuine argument for using
them, and it's still an argument for enrichment rather than discovery.

### D. Verified-only feeds gate the wrong thing

§4 and §14 gate RSS/ICS generation on claimed status, and §14 already flags the doubt. Two problems:

1. It's the **fan** and **journalist** audiences (§5 secondary and tertiary) that feeds serve, and both are cut off from essentially the whole catalog — including the ~790 pre-generated artist pages.
2. There's no cost or trust reason for the gate. The data is auto-populated either way; a feed is a cached read.

Better lever: **give everyone feeds, and give claimed artists control.** Editing, ordering, correcting a wrong release, adding a pre-order, writing the announcement blurb — those are worth claiming for, they're the things only the artist can do, and they're a far stronger claim incentive than "you may have an RSS URL."

### E. Auto-populated release pages will mint wrong-artist URLs

This is the risk the spec doesn't name. §14 asks whether unclaimed artists should get release pages; the sharper question is what happens when the data is wrong.

The Bandcamp probe has a known residual wrong-artist rate (~4%, `docs/specs/bandcamp-coverage-research.md`). Today a wrong link is one row in a search result. Under this spec it becomes a **permanent, indexable, shareable URL with `MusicRelease` JSON-LD and an og:image** asserting that artist X released album Y. That's a materially worse failure mode, and it's the kind of thing that damages trust with exactly the artists this product is for.

Ship the correction mechanism *with* the feature, not after. There's a good pattern to copy: `platform_link_suppressions` (migration `20260729130000`) — scoped suppression with a normalized match key and a global-vs-per-artist distinction, already wired into the search pipeline and an admin UI.

Related, and worth deciding explicitly: **`noindex` release pages until they clear a quality bar** (≥2 platform links, or a release date, or a claimed artist). ~800 auto-generated pages holding artwork and one link is textbook thin programmatic content, and it cuts against the no-SEO-slop line the rest of the product holds.

### F. Routing: `/a/*` already claims the release-page path

`netlify.toml` routes `/a/*` → `artist-page-static`. `/a/{artist}/{release-slug}` matches that pattern, so today it would render as an artist page with the slug `"artist/release"`. A new `path = "/a/:artist/:release"` edge route must be declared *before* `/a/*`, and Netlify edge-route precedence with overlapping patterns needs verifying on a deploy preview rather than assumed.

Also keep §"one route, one renderer" in view: `/a/:slug` is pure SSR with no React hydration. The release page must be the same — pure SSR — or it reopens the bifurcation bug class documented in `docs/retros/UNS-100-bifurcation-retro.md`.

### G. Data-model gaps

- **No index for the primary query.** Both the artist-page section and the feed sort an artist's releases by date. Only `(artist_id)` is indexed. Add `(artist_id, release_date desc nulls last)`.
- **Nullable sort key with no tiebreaker.** `release_date` is nullable and V1 data will frequently lack it, so "newest first" is nondeterministic. Add a stable secondary sort (`created_at desc`) and decide where undated releases sit.
- **No hidden / needs-review state.** Follows from (E).
- **No `CHECK` on either `source` column**, and the two schema files disagree on its values (see Part 1).
- **`musicbrainz_id` not unique** despite being called the canonical dedup key.

### H. Open questions in §14 that are already answerable

- *"Do we keep writing `latest_release` after the migration?"* — Yes, keep it. It's load-bearing for search disambiguation (`allReleaseTitles`, release-overlap merging in `search-utils.ts`), and the new tables serve display. Two consumers, two shapes; that's fine. Say so in the spec and stop treating it as debt.
- *"iTunes Search API access — need a developer token."* — No token needed; `itunes.apple.com/search` is public and unauthenticated, ~20 req/min soft limit, and it does return `collectionType` / `wrapperType` for album-vs-single. It will need adding to `ALLOWED_OUTBOUND_HOSTNAMES`. Worth confirming against current terms before relying on it. But see (C2): the constraint on iTunes is mission, not access — enrich only, never discover.
- *"Odesli access — still worth investigating for V2."* — Resolved by the premise correction above. Odesli is live; its **public API** is what was retired. So there's no API to get access to, and no dead-competitor gap to fill. Treat cross-platform link resolution as a genuinely separate, later question.
- *"Release page for unclaimed artists?"* — Yes, but `noindex` until the quality bar in (E) is met.

---

## Part 3 — recommendation

**Given the pause:** close PR #336 with a link to this document, so the branch doesn't rot
into a stale merge conflict that someone later tries to rebase. Nothing in it is worth
keeping as code — see the last line of this document. `feat/releases` and the local
`docs/releases-review-336` branch can both go once this doc is somewhere durable.

Everything below is the plan **for whenever this restarts**, except "the one thing to ship
anyway", which is not blocked by the pause.

**Releases, in order, when it restarts:**

- **PR B — schema only.** Migration 029, corrected: `CHECK` constraints on both `source` columns, `unique(artist_id, musicbrainz_id)` where non-null, `(artist_id, release_date desc nulls last)` index, `is_streaming` dropped in favour of deriving category from the platform registry, and a `status` / `hidden` column for corrections. No application code. Deployable and reversible on its own.
- **PR C — catalog ingest, off the request path.** Two sources, either order:
  Mirlo via `GET api.mirlo.space/v1/artists/<slug>` → `trackGroups[]` (full discography, one
  request, already allowlisted — see B); and Bandcamp by extending the `/music` parser to keep
  the `href`, display-quality title, artwork, date, and pre-order state from HTML the probe
  already fetches. Write from the probe's existing cache-write path or a scheduled function —
  **not** from inside `persistSearchResults`. `COALESCE` merge, not blind upsert (finding #4).
  Sanity-bound dates. Drop `scripts/migrate-releases.ts`; the catalog supersedes the jsonb lift.
- **PR D — `release-utils.ts` + tests.** One normalize function built on `normalizeForComparison`, a real hash for collisions or the specced UUID, non-Latin titles handled rather than dropped, and unit tests covering all three. Small enough to review in one sitting, and it's the file every later phase depends on. Realistically this lands *with* or *before* PR C.
- **PR D2 — dedup.** Broken out because B2 makes it the largest line item, not a step inside
  PR C. Match within release type; MB release-group id where present; normalized title + date
  proximity otherwise. This is the one to prototype against real data *before* committing to
  the rest.
- **PR E — release page.** Pure SSR edge function, route declared before `/a/*` and verified on a deploy preview, `noindex` below the quality bar, suppression wired in.
- **PR F — feeds.** Atom + ICS for everyone, not just claimed artists. The upcoming-release
  framing is safe to keep for Mirlo artists from day one (see C); Bandcamp pre-orders can
  follow.

**Spec edits to make before building:** correct the §1 Odesli premise; delete the
`latest_release` lift from Phase 1 and replace it with catalog capture; move full-catalog
scraping from Phase 5 to Phase 1; record the verified Mirlo `trackGroups` endpoint in place of
"Mirlo RSS"; make "direct-support sources discover, iTunes/MB only enrich" a locked V1
decision in §4; flip feeds from verified-only to everyone-reads/claimed-edits; add
correction/suppression and `noindex` gating as Phase 2 requirements rather than V2
nice-to-haves; promote dedup from a §15 risk row to a phase of its own.

Salvageable from #336 as code: the migration's structure and RLS pattern, and the *shape* of `release-utils.ts`. The rest is worth rewriting rather than patching, mostly because the thing it was built to do (lift the jsonb) is the thing that shouldn't be done.

---

## The one thing to ship anyway

**`check-releases` is unauthenticated, unvalidated, and unmetered on `main` today.** This is
independent of the Releases feature and should not pause with it.

Verified against `origin/main`: `api/functions/check-releases.ts` has **no** URL validation,
**no** allowlist check, and **no** rate limit. It accepts a POST body with
`platforms.bandcamp` / `platforms.faircamp` and fetches those URLs directly
(`checkBandcamp` line 89, `checkFaircamp` line 155). `checkBandcamp` then follows a link found
*inside* the fetched page (line 118), so it's a two-hop fetch. Parsed content from the fetched
URL comes back in the response as `releaseName` / `releaseUrl`, so it reflects a limited amount
of what it retrieved.

What that adds up to:

- **SSRF with partial content reflection** — an unauthenticated caller can point it at internal
  or cloud-metadata addresses and read a little of what comes back. The `ALLOWED_OUTBOUND_HOSTNAMES`
  helper exists precisely to block this and every other outbound fetch in the codebase already
  routes through it. `check-releases` is the gap.
- **An unmetered outbound request amplifier** — a free, anonymous endpoint that will fetch any
  URL you name from Netlify's IPs, usable to proxy traffic at a third party and to burn function
  minutes.

Not a drop-everything emergency: it reflects parsed fields rather than raw response bodies, and
`checkMirlo` uses a hardcoded URL so only two of three paths are exposed. But it should be
fixed on its own merits, soon, in a small PR:

1. Route both URLs through `isUrlHostnameAllowed()` — **with** a real answer for self-hosted
   Faircamp. An allowlist is the wrong tool there; checking the URL against what's already
   persisted in `artist_links` for that artist gives the same guarantee without breaking the
   platform (Part 1, finding #7).
2. Add a rate limit that **fits the clients** — a batch request shape, or `lenient` plus
   429-aware clients that reschedule. Do not ship the `strict` tier against per-artist client
   loops (Part 1, finding #1); that trades a security hole for silently broken release alerts
   in both the Mac app and the extension.
