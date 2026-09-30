---
status: Approved
---
# Artist bio excerpt on search and detection results

**Owner:** Brandon · **Drafted:** 2026-09-30 · **Clients:** Mac/iOS app, browser extension, web (in that priority order)

## The idea

Every artist result — typed search or a proactive detection in the extension or Mac app — shows a short bio excerpt. It expands inline if it's long, and always links to where it came from. One bio, one source, never stitched together.

## What already exists (and why it isn't visible)

The research turned up more existing work than expected, and some of it is broken:

| Piece | State |
|---|---|
| `artist_profiles.bio` | Exists. Claimed artists write it at `/artist-edit/:slug`, capped at 500 chars (`artist-profile.ts`). `db.ts` already loads it into `ArtistProfile.bio`. `toStoredResult` doesn't put it on the search result. |
| `fetchWikipediaSummary` (`api/search/enrichment.ts`) | Runs in Phase 2 **and** in Phase 1's server-side enrichment. Returns `wikipediaSummary` / `wikipediaUrl` on the result. **No client renders it**: the web types and `mergeWithMusicBrainzData` carry it, and nothing displays it. |
| How the Wikipedia URL is found | Only from a direct `en.wikipedia.org` relation on the MusicBrainz artist. MusicBrainz moved to **Wikidata** relations years ago, so most well-documented artists have a Wikidata link and no Wikipedia link, and the summary quietly doesn't fire. |
| Discogs artist API | `fetchDiscogsSocialLinks` already calls `api.discogs.com/artists/{id}` for socials. That response includes a `profile` field, the Discogs bio, and we throw it away. |
| Bandcamp `/music` page | The probe (`bandcamp-probe.ts`) and `fetchBandcampLocation` already fetch the page that carries the artist's sidebar bio. Location is parsed from it today; the bio isn't. |

So most of this feature means using data we already fetch. Only one new outbound request is needed: the Wikidata hop.

## Pressure-testing the proposed source order

The proposal was: Unstream page, then Bandcamp, then MusicBrainz, then Wikidata/Wikipedia, skipping empty bios at each step.

**1. Unstream first is right, with one clarification.** "Verified" means two things in this codebase. The search result's `matchConfidence: 'verified'` is an identity check, and those artists have no bio. Only **claimed** profiles (`matchConfidence: 'claimed'`) have one. So the rule is *claimed profile bio*. It's also the escape hatch for artists-first: an artist who dislikes the Wikipedia or Discogs text can claim their page and write their own, which then wins everywhere.

**2. Bandcamp second is right.** It's the artist's own words, and it costs nothing extra because the page is already fetched. The risk is attaching the **wrong artist's** bio. A bio is far more visible than a link, and a stranger's biography under your name is the kind of over-merge this codebase treats as the worst outcome. So we only take the bio from a Bandcamp account the result already trusts: a probe `accepted` verdict, or a MusicBrainz-supplied URL that survived the dead-subdomain check. Never from an `undecided` or name-only match.

**3. MusicBrainz has no bio, so that step can't work as written.** MusicBrainz artists have a one-line `disambiguation` ("US indie rock band") and a free-text `annotation`, which is mostly editor notes and not prose. MusicBrainz's own site shows a Wikipedia extract that it gets **through Wikidata**. So "MusicBrainz bio" and "Wikipedia bio" are the same source, and steps 3 and 4 collapse into one.

**4. The step that belongs in that slot is Discogs.** It's already fetched and free. Its `profile` is usually real prose, including for underground artists that Wikipedia will never cover. It's CC0, so there's no attribution obligation, though we'll link it anyway. The cost is cleanup: Discogs markup (`[a=Artist]`, `[l123]`, `[url=…]…[/url]`, `[b]`) has to be converted to plain text, and that's a pure function with a test.

**5. Wikipedia goes last, reached via Wikidata.** It's third-party and written for an encyclopedia, not for fans, and it only covers artists notable enough to have a page. That's the reverse of who Unstream is for, so it's the right fallback, but only a fallback. Its licence (CC BY-SA 4.0) requires attribution, so the source link reads "From Wikipedia" with a licence link, not a bare URL.

**6. "Skip empty" isn't a strong enough filter.** A lot of real Bandcamp bios aren't empty but aren't bios either: `booking: x@y.com`, a list of URLs, "new album out now!", a single emoji. The rule becomes **skip unless usable**: remove URLs, email addresses and handles, collapse whitespace, then require **at least three words** of what's left. There's deliberately no character minimum, so a short real bio like "Noise duo from Leeds." is shown (decided 2026-09-30). This removes contact-only and link-only bios and emoji, and lets short promo lines like "new album out now!" through. That's acceptable, because it's still the artist talking.

**7. A bio that couldn't be fetched isn't "no bio".** This is the "never cache uncertainty" trap again, in two places:
- `fetchWikipediaSummary` returns `null` for a 404, a timeout and a network error alike. The MusicBrainz response is cached for 30 minutes, so one Wikipedia hiccup hides the bio for 30 minutes. It needs to distinguish "no page" (cacheable) from "didn't answer" (not cacheable, via the existing `shouldCache` predicate).
- Adding a `bio` column to `bandcamp_slug_probes` has the same trap the location column had. Every row cached before the migration has `bio = NULL`, which reads as "this artist has no bio". The fix is to have the probe store `''` for "checked, nothing usable" and leave `NULL` meaning "never checked". Old rows then get no Bandcamp bio until they naturally re-probe, and the fallback chain still runs for them. We don't re-fetch to backfill.

**8. The chain resolves in phase order, which is lucky.** Claimed and Bandcamp are available in Phase 1. Discogs and Wikipedia arrive in Phase 2, or in Phase 1 when enrichment lands in time. The higher-priority sources arrive first, so Phase 2 only ever **fills** an empty bio and never **replaces** one. There's no flicker from one bio swapping for another, and the client rule is one line: take Phase 2's bio only if the result has none.

**9. It only covers one result per search, and that's fine.** Phase 2 enriches the top MusicBrainz match, and the probe resolves one artist. In practice the primary result gets a bio and the rest usually don't. For detection, the case that matters most, there is only one artist anyway.

## Decisions

### Source order (final)

1. **Claimed Unstream profile**: `artist_profiles.bio`. Links to `/a/{slug}`. If the artist has turned bios off (see below), the chain **stops here with no bio**. It doesn't fall through to a third-party source.
2. **Bandcamp**: sidebar bio from a trusted `/music` page. Links to the Bandcamp page.
3. **Discogs**: `profile` from the artist API, with markup stripped. Links to the Discogs artist page.
4. **Wikipedia**: summary extract, found via the MusicBrainz → Wikidata → `enwiki` sitelink (a direct Wikipedia relation still counts if one exists). Links to the article, with attribution.

The first source that yields a **usable** bio (decision 6) wins. No merging across sources.

### Claimed artists can opt out of a bio (decided 2026-09-30)

Some artists will want *no* bio shown rather than Wikipedia's or Discogs' version of them. Artists first: they get a switch.

- A new column, `artist_profiles.show_bio BOOLEAN NOT NULL DEFAULT true`, added in a new migration. The existing `artist_profiles` RLS policies already cover the row, so no policy changes are needed. The migration still says so in a comment.
- The toggle is on `/artist-edit/:slug`, next to the bio field: "Show a bio on search results". Its help text: "If you haven't written one, we'll use your Bandcamp, Discogs or Wikipedia bio."
- `artist-profile.ts` PUT accepts `showBio`. The owner check is the one already guarding bio updates.
- With `show_bio = false`, `pickBio` returns nothing for that artist. Phase 2 can't fill it in either: the Phase 2 response carries `bioSuppressed: true` for a claimed, opted-out artist, and each client's one-line fill rule already skips filling when the result came from a claimed profile. That means the fill rule is keyed on "Phase 1 said no bio *and* the artist isn't claimed", not just "empty".

### Computed on the server, rendered by the clients

The server picks the bio. The Swift, extension and web code render only. Implementing the selection three times is the same mistake the `artistSlug` comment in `search-sources.ts` warns about. The pure logic (cleanup, usability check, pick) lives in a new small module, `api/shared/artist-bio.ts`, with tests. `search-sources.ts` doesn't grow beyond wiring.

### Response shape

A `bio` object replaces `wikipediaSummary` / `wikipediaUrl` on `SearchResult` and on the Phase 2 response:

```ts
bio?: {
  text: string;        // plain text, paragraphs separated by \n\n, capped at 1,000 chars on a word boundary
  source: 'unstream' | 'bandcamp' | 'discogs' | 'wikipedia';
  sourceUrl: string;   // always present — the "read more" link
  truncated: boolean;  // true when the server cap cut the text, so clients say "Read more on X" rather than implying they showed it all
}
```

Keep `wikipediaSummary` / `wikipediaUrl` for one release so the currently shipped Mac app and extension builds don't break. They decode leniently, but removing a field is still a contract change. Delete them once the new builds are out.

Plain text only. Bandcamp bio HTML (`<br>`, links) is converted to text on the server, and every client renders it as text, never as HTML. That makes XSS structurally impossible rather than something we have to escape correctly each time.

### Display rule (every client)

- Clamp to **3 lines** (web and extension) or **2 lines** (Mac menu-bar popover, where space is tighter; iOS gets 3).
- If the text fits, show it all with no "More".
- If it doesn't, show a **More** control that expands inline. Nothing opens until the user asks.
- Always show a small source line that names the platform: `From Bandcamp ↗`, `From Discogs ↗`, `From Wikipedia · CC BY-SA ↗`. The one exception is a claimed profile's own bio, which reads `From the artist ↗` and links to their `/a/{slug}` page (decided 2026-09-30). The link opens `sourceUrl` in a new tab or the default browser. The labels come from `source` in one small per-client map, so there's no label text in the API response.
- No bio: render nothing. No placeholder, no "no bio available".

### Caching and cost

- **Bandcamp**: a new nullable `bio TEXT` column on `bandcamp_slug_probes`, following the location precedent: a new migration, RLS unchanged (server-only table, no policies), `''` vs `NULL` as in decision 7. It's written only when a probe row is written anyway, so it adds **zero** Supabase writes. That matters given the disk I/O history.
- **Discogs**: no new request. Read `profile` from the response `fetchDiscogsSocialLinks` already gets, which means changing its return shape to `{ socialLinks, profile }`.
- **Wikidata hop**: one extra request, `wbgetentities?ids=Q…&props=sitelinks&sitefilter=enwiki`, then the existing summary fetch. It runs inside the Phase 2 `Promise.all`, sequentially only with its own summary fetch. Both hosts are already in `ALLOWED_OUTBOUND_HOSTNAMES`. It's cached inside the existing 30-minute MusicBrainz entry, so there's **no new Redis command**. Timeout of 2.5s, so it can't push Phase 2 past the function ceiling.
- **Claimed bio**: already loaded by `getArtistBySlug`, so it's free. `show_bio` rides the same select.
- The payload is ≤1 KB per result, on one result per search. That's negligible in Redis storage, and it doesn't change the command count.

### Out of scope for v1

- **Public API v1.** Wikipedia's share-alike licence would pass through to API consumers, which is a documentation job (`docs/openapi.yaml`) worth doing on purpose, not by accident. Follow-up.
- **Discord bot, edge-rendered `/artist/:slug` pages.** Same data; do it once the result field has proven itself.
- **Admin suppression of a bad bio.** Claiming is the artist's own fix. If a wrong-artist bio shows up in practice, extend `link_suppressions` rather than building something new.
- **Non-English Wikipedia.** en-only today, same as the current code.
- **A MusicBrainz `disambiguation` one-liner as a last resort.** It's a subtitle, not a bio, and it would make "has a bio" true for almost everyone without saying much. Revisit if coverage turns out thin.

## Build plan

The order follows the client priority: the backend first, because every client depends on it, then Mac and the extension, then web.

1. **`api/shared/artist-bio.ts` + tests.** `cleanBandcampBio(html)`, `cleanDiscogsProfile(text)`, `isUsableBio(text)`, `capBio(text)`, `pickBio(candidates)`. Pure functions, with fixtures from real pages: several Bandcamp sidebars (including a contact-only one), Discogs profiles with markup, a Wikipedia extract.
2. **Bandcamp.** Parse the bio in `bandcamp-probe.ts` from the HTML it already has, and in `fetchBandcampLocation`'s page. Add the migration for the `bio` column with `''`/`NULL` semantics. Verify the parser against a real page with one `ingest:try`-style request before relying on it; there's no `/music` sidebar fixture in the repo yet.
3. **Discogs.** Return `profile` from the existing fetch.
4. **Wikipedia.** Resolve the Wikidata relation to its `enwiki` sitelink, and make `fetchWikipediaSummary` distinguish "no page" from "failed". Feed that into the MusicBrainz `shouldCache`.
5. **Opt-out.** Add the `show_bio` migration, `showBio` in the `artist-profile.ts` PUT handler plus its test, and the toggle on `ArtistEditPage.tsx`.
6. **Wire up.** `toStoredResult` adds the claimed bio, or none if the artist opted out. Phase 1 and Phase 2 both call `pickBio`. Also update `api/functions/search-utils.ts` (`AggregatedResult`), `apps/web/src/types/index.ts`, and `apps/mac/Unstream/Models/SearchResponse.swift`. Run `npm run verify`.
7. **Mac/iOS app.** `ArtistResultView.swift` gets the clamped text, More, and source link. The Phase 2 merge fills it only if it's empty. This ships as a Sparkle release, so bump `CFBundleVersion`.
8. **Extension.** `popup.js` `renderResults` + `popup.css`, with the same merge rule in `service-worker.js`'s Phase 2 handling. Chrome and Firefox store review add lead time, so submit alongside the Mac release.
9. **Web.** A new `ResultCardBio.tsx`, matching the `ResultCard*` split, and the one-line fill rule in `mergeWithMusicBrainzData`. Remove the dead `wikipediaSummary` plumbing once the native builds carrying `bio` are out.

## Decisions log

- **2026-09-30 (Brandon):** claimed artists can turn the bio off, with no fallthrough. Short real bios are shown: no character minimum, three words is enough. The source line names the platform, except a claimed profile's own bio, which says "From the artist".
