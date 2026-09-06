---
status: Done
---
# Unstream Releases — second-pass design review

**Written:** 2026-07-31
**Responds to:** `music-sindy-spec.md` (2026-07-28) and Brandon's re-pitch of 2026-07-31
**Prior art:** `../postmortems/unstream-releases-review.md` (2026-07-29 review + PR #336 teardown). PR #336 is closed. Feature was paused 2026-07-29.
**Verdict:** the re-pitch is a materially stronger case than the spec's, and one of its four arguments is a closed loop rather than a bet. But the spec's build plan is still wrong in the same place, and the honest version of the SEO argument is narrower than stated — naively executed it's a risk to the domain, not a boost. Recommended: a Mirlo-only vertical slice that proves the whole feature for roughly a day of work, before committing to Bandcamp catalog ingest or dedup.

---

## 0. What actually changed since the pause

The pause had two reasons. You've already conceded both, which is why this is worth reopening.

| Pause reason | Status now |
|---|---|
| §1's premise was wrong — Odesli isn't dead, so there's no void | You dropped it. Your framing is "risks being shut down," and you led with "this is a bit of a stretch of a user problem." Conceded, not re-pitched. |
| Dedup cost — going after real discographies promotes cross-source dedup to the main line item | You named it yourself: "the critical piece is disambiguating between releases across platforms." Conceded. |

So neither pause reason is being argued around. The live question is whether the payoff justifies the dedup cost. **Section 3 argues the cost is smaller than either of us thought — because the answer is to stop trying to solve dedup automatically.**

### One fact correction, in both directions

You said Odesli was "recently bought by Linktree." The acquirer is right — I had it wrong in my notes, which recorded Musixmatch from the spec. But it wasn't recent: **Linktree acquired Songlink/Odesli in 2021**, roughly five years ago, and the product has run continuously since.

That weakens "risks being shut down" as urgency — five years of stable operation is evidence against imminent shutdown, not for it. The real signal is the one I verified in July: **Odesli's public API was retired while the product stayed up.** That's the shape of a product being maintained but not invested in, owned by a link-in-bio company whose interest is streaming reach.

Which is a fine reason to build, just not a clock. Keep the strategic read ("strategically owned by a competitor whose incentives point at streaming"), drop the timing claim.

---

## 1. The strongest version of your case

You gave four arguments. They are not equally strong, and the order you listed them in is close to inverse to their actual strength.

### 1.1 The notification-destination gap — your best argument, and it's verified

You wrote: *"we already have release notifications built in but the release page gives a much more delightful and Unstream-centric place to route those notifications to."*

I checked. Today, a release alert in the Mac app carries `releaseUrl` — the raw platform URL — and opening the notification sends the user straight to Bandcamp ([ReleaseAlert.swift:9](apps/mac/Unstream/Models/ReleaseAlert.swift:9), [UnstreamApp.swift:252](apps/mac/Unstream/UnstreamApp.swift:252)). Same in the extension.

So Unstream currently does the hard part — knowing an artist you support just released something — and then hands the user off to a single platform, chosen by a hardcoded priority order (`mirlo > faircamp > bandcamp`, [check-releases.ts:299](api/functions/check-releases.ts:299)). If the album is on Bandcamp *and* Mirlo, the user never learns that, and never sees the payout difference that is Unstream's entire thesis.

This is the one argument that isn't speculative. It's a loop that's already 80% built and terminates in the wrong place. Everything else here is a growth bet; this is a defect.

### 1.2 The catalog deletes a scaling problem you already have

This didn't appear in the spec or my last review, and it may be the best *technical* reason to build it.

Release checking today is client-side polling. The Mac app loops over every supported artist, one request each, no batching ([ReleaseAlertManager.swift:203](apps/mac/Unstream/ReleaseAlertManager.swift:203)); the extension does the same weekly. Each of those requests makes Netlify fetch a Bandcamp `/music` page and then a second album page for the date. So:

> **N clients × M artists → 2NM scrapes of Bandcamp**, with no shared cache, repeated every week, for data that is identical for every user.

A server-side catalog inverts this to **one crawl per artist per interval, and every client reads Unstream**. That is strictly better on four axes:

- **Respects other people's servers** — a stated engineering principle, currently violated at a multiplier.
- **Kills the SSRF exposure** rather than patching it. `check-releases` is still unauthenticated, unvalidated, and unmetered on `main` (confirmed today — no `isUrlHostnameAllowed`, no `checkRateLimit`). The catalog makes the endpoint unnecessary instead of requiring the awkward rate-limit-versus-broken-alerts trade-off from my last review.
- **Fixes the rate-limit trap** — there's no per-artist client loop left to break.
- **Instant clients** — reading a catalog is one request, not M sequential scrapes.

Frame this internally as *"replace client-side polling with a catalog"* rather than *"add release pages."* Same work, and it's a reliability and good-citizenship story rather than a feature story.

### 1.3 The genuinely novel product: formats, prices, and payout per release

This is missing from the spec entirely and it's the thing nobody else does.

Odesli answers *"where can I stream this?"* Distributor pages answer *"where can I stream this?"* feature.fm answers *"where can I stream this?"* **Nobody answers "where can I buy this, in what format, at what price, and how much reaches the artist."**

That data is available. Verified today:

- **Bandcamp album page** — `datePublished`, format offerings (this one had Vinyl + Digital Album), `price`, `priceCurrency`, and pre-order state.
- **Mirlo `trackGroups`** — `minPrice`, `suggestedPrice`, `currency`, `isPreorder`, and `platformPercent` (the actual payout share, per release).

A release page that says *"Vinyl $30 · Bandcamp · 82% to artist / Digital $8 · Mirlo · 90% to artist / cassette sold out"* is a better answer than anything currently on the internet for "where do I buy X," and it's the only version of this feature that is recognisably Unstream rather than a reskinned Odesli.

**This should be in V1's data model even if the UI lands later.** It's the differentiator, and retrofitting an offers table after pages ship is more work than including it.

### 1.4 SEO — real, but narrower than stated, and a risk if done naively

I'd push back here, in line with the no-SEO-slop principle.

**The bad version.** ~800 artists × ~20 releases ≈ **16,000 auto-generated pages**, most holding artwork, a title, and one outbound link. That is textbook scaled content abuse. Google's spam policies target it explicitly, and the penalty surface is **site-wide, not page-scoped** — meaning a naive rollout risks the artist-page and guide rankings you've already earned. Your premise #1 inverts: done carelessly this is an SEO liability with a five-figure page count.

**The good version.** Release pages are where **transactional** intent lives — "buy *album* vinyl", "*album* bandcamp", "where to buy *album*". Those queries are (a) numerous, (b) poorly served today, and (c) exactly what section 1.3's data answers better than any incumbent. That's a real and defensible SEO position.

The distinguishing variable is entirely page quality. Which means the quality bar isn't hygiene bolted on at the end — **it is the SEO strategy**. Concretely:

- `noindex` until a page clears a bar (≥2 platform sources, **or** ≥1 source with real offer data, **or** a claimed artist).
- Let pages earn indexation as data accrues, rather than minting 16,000 and pruning.
- Expect the indexable set to start in the low hundreds. That's the point.

Also unaddressed in the spec: 20 release pages per artist **compete with the artist page** for that artist's brand query. Needs a deliberate internal-linking and canonical story.

### 1.5 The insight the spec misses: feeds should be per-fan, not just per-artist

The spec has only `/feed/{artist-slug}`. But a fan following 40 artists does not want 40 RSS subscriptions and 40 calendars.

The valuable object is **one feed containing every upcoming release from every artist I've saved.** And the infrastructure already exists: saved artists sync to the Apple app, `usernames` carries a `saved_artists_public` flag, and `/u/:handle` already renders a public saved list ([public-saved-artists.ts:51](api/functions/public-saved-artists.ts:51)).

So `/u/{handle}/releases.ics` — a live calendar of everything your saved artists have coming — is a bigger product than per-artist feeds, built on shipped infra, and it has no equivalent anywhere. Per-artist feeds serve the artist's promotional need; the per-fan feed is the one fans would actually use.

**Corollary: don't add a "subscribe" relationship.** You already have saved and supported. A third verb is a taxonomy tax on users and code. *Saved* is the subscription; the feed is a view over it.

### 1.6 The artist-side inversion — the hardest unsolved problem in the concept

This is the caveat that most affects whether the artist pitch lands, and neither the spec nor my last review framed it sharply.

Distributor landing pages and feature.fm are **pre-release** tools. The artist sets one up *before* release day, and its main job is the pre-save/pre-order window and the announcement. Unstream's pipeline is **discovery-based** — it finds releases that already exist.

> **The moment of maximum value to an artist (announce day) is precisely the moment our data is weakest — the release isn't out, so there's nothing to discover.**

An artist will not replace their smart link with a page that appears three days after they needed it. So the artist-facing pitch has a hard dependency the spec never states: **claimed artists need to create a release page before the release exists.** Auto-generation serves fans and SEO; artist authoring serves artists. They are two products sharing a table, and only one of them is in the spec.

Partial mitigation, verified: **Mirlo carries genuine future dates.** Live today I saw releases dated `2027-09-07`, `2026-10-10`, `2026-09-04` — all forward of today — plus an `isPreorder` flag. So for Mirlo artists the pre-release window is reachable from ingest alone. Bandcamp pre-orders are detectable on the album page (`preorder` appears in the markup) but not in the grid. Everyone else needs the authoring flow.

---

## 2. Spec vs. how I'd build it

| # | Spec says | I'd do | Why |
|---|---|---|---|
| 1 | Phase 1 lifts `artist_links.latest_release` jsonb into the new tables | **Delete the lift.** Ingest real catalogs from Mirlo + Bandcamp | The jsonb holds *one release per platform*. On launch day the "chronology," the Atom feed, and the ICS calendar each hold exactly one item — the release the fan already saw. Every headline feature stands on data that can't carry it. This was the load-bearing finding last time and it hasn't changed. |
| 2 | Sources listed as co-equal: Bandcamp, Mirlo, MB, iTunes | **Mirlo first and alone for the slice.** Bandcamp second, two-tier. MB/iTunes enrich only | Verified economics below. They differ by more than an order of magnitude. |
| 3 | "Mirlo RSS" for catalog | `GET api.mirlo.space/v1/artists/{slug}` → `trackGroups[]` | The RSS endpoint in `check-releases` is a *global* recent-releases window, not a per-artist discography. Verified: the artists endpoint returned **33 releases in one request** for Time Rival. |
| 4 | Dedup key is MB release-group id, then title+date | **`external_id` per source as the identity anchor** | Bandcamp's grid exposes `data-item-id="album-1891263657"` — a stable per-release id *and* an album/track type prefix. Mirlo has `id`. Anchoring on these makes re-crawls idempotent even when titles change, and removes most of the title-matching surface. The spec has no external-id concept at all. |
| 5 | Dedup is a §15 risk row, solved by title+date proximity | **Its own phase, and mostly *not* automated** — see §3 | It's the largest line item and the reason for the pause. Auto-merge only on hard identifiers; queue the rest. |
| 6 | `is_streaming boolean default true` | Drop it; derive from `PLATFORMS[id].category` | Registry is the single source of truth. A third of the spec's streaming ids aren't Unstream platforms at all, and the default is backwards for a non-streaming catalog. |
| 7 | No format/price/offer concept | **`release_offers` table in V1** | §1.3 — the differentiator. |
| 8 | `release_type in ('album','single','ep','compilation')` | Keep source-native types; never collapse | Type is the highest-value dedup signal (match *within* type). #336's `mapReleaseType` collapsed everything to album-or-single and could never emit ep/compilation. |
| 9 | Feeds for verified artists only | **Everyone reads; claimed artists edit** | Feeds serve fans and journalists — the two audiences the gate excludes. Editing is the real claim incentive, and (§3) it's also the dedup labour. |
| 10 | Feeds are per-artist | Per-artist **and** per-fan (`/u/{handle}/releases.ics`) | §1.5. |
| 11 | Release page at `/a/{artist}/{release}`, edge-rendered | Same, but **pure SSR**, route declared *before* `/a/*`, precedence verified on a deploy preview | `/a/*` currently routes to `artist-page-static` and would swallow the child path. And a hybrid renderer reopens the UNS-100 bifurcation class. |
| 12 | Correction/suppression is V2 | **Ships with the feature** | Auto-generated pages mint permanent indexable URLs with `MusicRelease` JSON-LD. The probe's ~4% wrong-artist rate becomes a durable false claim about a real artist, not one bad search row. Copy `platform_link_suppressions`. |
| 13 | Silent on Mirlo visibility flags | **Respect `isPublic` / `hideFromSearch`** | Verified present on `trackGroups`. An artist set those deliberately. Ingesting them anyway is a trust violation of exactly the kind this product exists to avoid. |
| 14 | Silent on date hygiene | **Sanity-bound every date on ingest** | The `2925-11-02` typo is *still live* in Mirlo's data today, two days after I first found it. Unbounded, it sorts to the top of every chronology and lands in every subscriber's calendar. Also `releaseDate: null` is common, and one release came back with an **empty title** and a `mi-temp-slug-…` draft slug. |
| 15 | Silent on partial dates | Add `date_precision` | MusicBrainz gives year-only and month-only dates. Rendering "January 1" for a year-only date is a fabrication, and it poisons ±N-day dedup. |

### Verified source economics — the asymmetry that should drive the build order

| Source | Requests for a full discography | What you get | Verdict |
|---|---|---|---|
| **Mirlo** | **1** | 33 releases with `title`, `releaseDate` (incl. **future**), `type`, `cover`, `minPrice`, `currency`, `isPreorder`, `platformPercent`, `totalTracks`, `isPublic`, `hideFromSearch` | Near-free and richer than the spec's *entire* V1. Start here. |
| **Bandcamp** | **1 + N** | Grid (1 req): stable `data-item-id`, type prefix, href, artwork, display title — **but no dates**. Album page (1 req each): date, formats, prices, pre-order | Two-tier. Widest coverage, real crawl cost. |
| **MusicBrainz** | 1–2 | release groups, types, partial dates, MBIDs | Enrich only. |
| **iTunes** | 1 | titles, types, dates, artwork | Enrich only. No token needed. |

**Correction to my own prior review:** I wrote that Bandcamp artwork *and date* were "in the same DOM node the parser already stands in," and concluded full-catalog capture was free. The artwork half is right; **the date half is wrong.** Dates live only on individual album pages. So Bandcamp full catalog with dates is 1 + N requests — for the 16-release artist I sampled, 17 requests, and across ~800 artists on the order of **16,000 fetches**. That's a crawl programme, not a parser change, and it needs to be lazy and prioritised rather than a blanket sweep. This materially changes the cost case and is the main reason I'd start with Mirlo.

Two more Bandcamp traps found today:

- **Custom domains.** `sufjanstevens.bandcamp.com/music` **302s to `music.sufjan.com/music`**. Bandcamp Pro artists routinely do this. Two consequences: the probe must follow redirects and store the canonical host, and — more importantly — **an allowlist check on the input URL does not constrain the URL actually fetched.** `fetch` follows redirects by default and `checkBandcamp` already does a second hop to a link found *inside* the fetched page. So `isUrlHostnameAllowed()` on the input alone is a redirect-bypassable SSRF control. Re-check the hostname after each hop, or pin `redirect: 'manual'` and validate each Location.
- **Grids mix albums and standalone tracks.** The `data-item-id` prefix (`album-` / `track-`) distinguishes them, but a naive chronology becomes mostly pre-release singles that later appear on an album. And series-heavy artists break the UI: Time Rival's 33 releases include *Inaction I–V* and *Outside Vol. 1–4*. "Newest first" alone is not a design.

---

## 3. The dedup problem — and why it's smaller than it looks

This is what paused the feature, and it's what you correctly identified as critical. My answer has changed since July: **don't try to solve it.**

The spec (and #336) treat dedup as an algorithm to get right. That framing is what makes it the largest line item, and it's also the framing most likely to produce silent, permanent errors. Reframe it as three tiers:

**Tier 1 — hard identifiers. Auto-merge, no judgement.**
Same `(platform, external_id)` → same source row, always. Same MB release-group id → same release. This is the bulk of repeat-crawl traffic and it's exact.

**Tier 2 — exact normalized title *within* release type. Auto-merge.**
Use `normalizeForComparison` from `search-utils.ts` — it NFD-folds accents rather than deleting them. (#336 hand-rolled a normalizer that turned "Björk" into "bj-rk" and Japanese/Cyrillic titles into empty strings, silently dropping those releases entirely.) Scope the comparison to matching types so an album and its lead single never merge.

**Tier 3 — everything else. Do not auto-merge. Queue it.**
Fuzzy title distance, ±N-day proximity, deluxe/remaster variants. Write these to a review queue instead of acting on them.

The governing principle:

> **Under-merge, never over-merge.** A duplicate release page is embarrassing and self-evident. A wrongly merged page asserts, in JSON-LD with an og:image, that two different albums are one release — and nobody will notice.

And here's why tier 3 doesn't need to be solved before launch: **the artist is the reviewer.** Claimed artists fixing their own discography is simultaneously the claim incentive (§2 row 9), the dedup labour, and the highest-quality signal available. There's already a working pattern for exactly this shape — `merge_overrides` for artist disambiguation, with an admin UI and a CLI.

That converts the pause's blocking objection from an algorithm problem into a UX problem with a human backstop. It doesn't make dedup free, but it takes it off the critical path.

### The sequencing move that pays for it

`mergeByReleaseOverlap` ([search-utils.ts:906](api/functions/search-utils.ts:906)) and `allReleaseTitles` already do a crude version of release matching — to decide whether two artist results are the same artist. A real release-identity layer is a **strict upgrade to logic search already depends on.**

So the expensive part can ship as a **search-quality improvement, before any release page exists**: better identity → better artist disambiguation → fewer wrong-artist merges. If it doesn't improve search, that's cheap early evidence the catalog isn't trustworthy enough to publish pages from — and you've learned it without minting a single indexable URL.

---

## 4. Recommended build order

The prior review's plan was six PRs starting with schema. I'd change the front of it: **prove the whole feature on Mirlo alone first.** Mirlo gives a complete discography, real dates including future ones, prices, pre-order flags, and payout percentages in *one HTTP request per artist*. That is enough to build every headline feature end-to-end — chronology, release page, Atom, ICS, notification routing — for a subset of artists, at trivial cost, before committing to Bandcamp crawling or dedup.

| Step | Scope | Notes |
|---|---|---|
| **0** | **`check-releases` hardening — ship now, independent of all of this** | Still unauthenticated, unvalidated, unmetered on `main`. Needs per-hop hostname validation (§2, redirect bypass), a stored-URL check rather than an allowlist for self-hosted Faircamp, and a batch shape or 429-aware clients so the limit doesn't silently kill alerts past artist #10. This is a live exposure and shouldn't wait. |
| **1** | Schema: `releases`, `release_sources` (with `external_id`), `release_offers` | Corrected per §2. RLS, CHECKs on both `source` columns, `unique(platform, external_id)`, `(artist_id, release_date desc nulls last, created_at desc)`, hidden/needs-review columns. No application code. |
| **2** | `release-utils.ts` + tests | One normalizer built on `normalizeForComparison`. Real hash (`createHash('sha1')`, not `crypto.subtle`) or the specced UUID for slug collisions. Non-Latin titles handled, not dropped. Date sanity bounds. Tests for all of it — the three worst #336 bugs were in fifteen lines of untested pure logic. |
| **3** | **Mirlo ingest, off the request path** | One request per artist. `COALESCE` merge, never blind upsert (#336 overwrote good artwork and dates with NULL from partial fetches). Respect `isPublic`/`hideFromSearch`. Filter empty-title drafts. Scheduled function or the probe's cache-write path — **not** inside `persistSearchResults`, which is awaited on the search hot path and would add ~0.6–1.6s to every search. |
| **4** | Release page — pure SSR, noindex gate, suppression wired in | Route before `/a/*`, precedence verified on a deploy preview. |
| **5** | Notification routing → release pages | Closes §1.1. Mac app + extension point at Unstream instead of a single platform. This is the payoff step; it's small once 4 exists. |
| **6** | Feeds: per-artist Atom + ICS, **and** per-fan `/u/{handle}/releases.ics` | Everyone reads. Upcoming-release framing is honest from day one on Mirlo data. |
| **7** | Bandcamp two-tier ingest | Grid for identity/artwork/type (cheap, already cached). Album detail lazily or on a prioritised schedule — claimed artists and recently-viewed releases first. Never a blanket 16k sweep. |
| **8** | Dedup tiers 1–2 automated, tier 3 queued + artist-editable | Prototype against real Mirlo↔Bandcamp overlap before committing to the matching rules. |
| **9** | Artist authoring flow for unreleased releases | Unblocks §1.6 and the artist-facing pitch. Arguably the real V2. |

Steps 1–6 are the vertical slice. If the feature is going to feel good, it will feel good at step 6 on Mirlo artists alone — and if it doesn't, you've spent no crawl budget and minted no indexable pages.

---

## 5. Decisions I need from you

1. **Does the artist pitch have to work in V1?** If yes, step 9 moves up and the shape changes significantly — authoring becomes the primary flow and auto-generation the backfill. If no, V1 is honestly a *fan-and-SEO* feature and the artist story is V2. The spec conflates these and it's the biggest scoping question.
2. **Indexation posture.** Comfortable starting with most release pages `noindex` and earning indexation, given §1.4? This is the direct trade against your SEO premise.
3. **Mirlo-only launch?** Shipping a Releases section that appears for Mirlo artists and a few Bandcamp ones is a visible inconsistency. Acceptable as a beta, or does it need breadth on day one?
4. **`release_offers` in V1 schema?** I'd say yes even if the UI is later — it's the differentiator (§1.3) and it's cheap now, expensive to retrofit.
5. **Is "subscribe" really just "saved"?** I'd reuse saved rather than add a third relationship (§1.5). Confirm.

## 6. Open questions I can't answer without building

- **Real Mirlo↔Bandcamp overlap rate.** Every dedup decision depends on this and I'm guessing. One afternoon against artists known to be on both would replace the guess. Worth doing *before* step 1.
- **Bandcamp album-page crawl budget.** What request rate is actually neighbourly, given `/music` is robots-permitted but per-album fetching at catalog scale is a different posture than one probe per artist.
- **Whether release identity measurably improves artist disambiguation** (§3). If yes, dedup pays for itself. If no, that's a signal to stop.
- **Artwork handling.** Hotlinking `bcbits.com` at catalog scale is fragile and impolite; rehosting raises rights questions. og:image needs a stable URL either way. Existing artist images set a precedent but releases multiply it ~20×.

---

## Appendix — what I verified today (2026-07-31)

- Mac release alerts open the raw platform URL; platform chosen by hardcoded priority. **§1.1 confirmed.**
- Mac app loops per-artist calling `check-releases`; no batching. **§1.2 confirmed.**
- `check-releases` on this branch still has no allowlist and no rate limit. **Step 0 still needed.**
- Bandcamp `/music` grid: `data-item-id="album-1891263657"`, href, artwork, display title. **No dates.** 16 items for the sampled artist.
- Bandcamp album page: `datePublished`, Vinyl + Digital Album offers, `price`, `priceCurrency`, pre-order markers.
- `sufjanstevens.bandcamp.com` **302s to `music.sufjan.com`** — custom-domain redirect, allowlist-bypass implication.
- Mirlo `GET /v1/artists/timerival` → **33 trackGroups in one request**, with `isPreorder`, `minPrice`, `currency`, `platformPercent`, `isPublic`, `hideFromSearch`, `type`, `cover`.
- Mirlo global feed today: future dates `2027-09-07`, `2026-10-10`, `2026-09-04`, `2026-08-07`; the **`2925-11-02` typo is still live**; `releaseDate: null` occurs; one release has an empty title and a `mi-temp-slug-…` draft slug.
- `/a/*` → `artist-page-static` in `netlify.toml`; no `/feed` route exists.
- `usernames.saved_artists_public` exists and backs `/u/:handle` — infra for per-fan feeds.
- Linktree acquired Songlink/Odesli in **2021**, not recently.

Sources for the acquisition date: [Music Business Worldwide](https://www.musicbusinessworldwide.com/linktree-acquires-songlink-odesli-and-launches-music-link-feature/), [PR Newswire](https://www.prnewswire.com/news-releases/linktree-announces-acquisition-of-songlinkodesli-and-launches-music-link-feature-301358565.html)
