# Bandcamp Coverage: Research & Options

> Status: **Research only** (26 July 2026). No code changed. All findings below were verified
> empirically against live Bandcamp endpoints on that date. Numbers will drift; the *shape* of
> the findings should hold.

## 1. What actually broke

**Corrected 26 July** — the live code map, verified rather than assumed:

| Path | Status |
|---|---|
| `api/functions/search-sources.ts:77` `searchBandcamp` | **Already disabled** — returns `[]` with a comment explaining the anti-bot block. This is the direct cause of the Phase-1 coverage loss. |
| `api/search/enrichment.ts:469` `searchBandcampForArtistUrl` | **Live and silently broken** — still fetches the blocked `/search`. |
| `api/search/enrichment.ts:518` `fetchBandcampLocation` | **Working.** ~90% success; see §5a. |
| `api/search/sources.ts`, `api/search/bandcamp.ts`, `api/search/site-search.ts` | Dead Vercel-era code (`VercelRequest` types), not imported by any Netlify function. |
| `apps/web/server/search/*` | Vite dev-server shim only. |

So there is exactly **one** live silent failure: `searchBandcampForArtistUrl`. It scrapes
`https://bandcamp.com/search?q=…&item_type=b`, which is now behind a Fastly bot challenge:

```
GET https://bandcamp.com/search?q=low%20hum
→ HTTP 200, 3,038 bytes, contains "_fs-ch-" (Fastly challenge asset path)
→ 0 matches for ".searchresult"
```

Two things worth naming:

1. **It fails silently.** The challenge returns `200`, so `if (!response.ok) return null`
   never trips. The parser finds zero `.searchresult` blocks and returns `null` — which is
   indistinguishable from "this artist isn't on Bandcamp." Nothing reaches Sentry.
2. **`/search` was never permitted.** `bandcamp.com/robots.txt` has carried `Disallow: /search`
   for years. The scrape was out of policy before it was blocked; the block just enforced it.

## 2. What Bandcamp's robots.txt actually permits

This is the operative policy signal, and it's more generous than the `/search` block suggests:

```
Disallow: /api/
Allow: /api/currency_data/
Allow: /api/discover/1/discover_mobile_web    ← explicitly allowed
Allow: /api/discover/1/discover_web           ← explicitly allowed
Allow: /api/tag_search/2/related_tags
Disallow: /search
...
User-agent: CCBot        Disallow: /
User-agent: GPTBot       Disallow: /
User-agent: ClaudeBot    Disallow: /
User-agent: Google-Extended / Bytespider / Amazonbot / meta-externalagent   Disallow: /
```

Artist subdomains (`<slug>.bandcamp.com/robots.txt`) carry the same rules **plus** advertise
`Sitemap: https://<slug>.bandcamp.com/sitemap.xml`. Artist and album pages are not disallowed.

So the permitted surface is: **the discover API, artist pages, and per-artist sitemaps.** The
disallowed surface is `/search` and the rest of `/api/`. Their AI stance
([Keeping Bandcamp Human](https://blog.bandcamp.com/2026/01/13/keeping-bandcamp-human/)) is about
AI-*generated music*, not crawling — the AI-crawler blocks in robots.txt are the relevant signal
there, and Unstream isn't one of those agents.

## 3. The find: `discover_web` is a full-catalog index, and it's allowed

`POST https://bandcamp.com/api/discover/1/discover_web` works server-side, with no cookies, no
browser, no TLS tricks, and an honest User-Agent.

```jsonc
// exact working payload — verified
{
  "category_id": 0,           // 0 = all genres
  "tag_norm_names": [],       // e.g. ["shoegaze"]
  "geoname_id": 0,            // 0 = worldwide; e.g. 5128581 = NYC
  "slice": "top",             // "top" | "new"
  "cursor": "*",              // opaque; echo back response.cursor to paginate
  "size": 500,
  "include_result_types": ["a"]
}
```

**Gotcha:** `include_result_types` must be `["a"]`. `["album"]`, `["t"]`, `["a","t"]` and `[]` all
return `Discover_1::DiscoverWebException`. That one-character difference is what makes this look
broken on first attempt.

### Verified properties

| Property | Measured |
|---|---|
| Declared index size | **6,258,177 albums** (`result_count`) — effectively the whole public catalog |
| Auth required | None. No cookie, no crumb, no token |
| User-Agent sensitivity | None. Works with `Unstream/1.0 (+https://unstream.stream)`, and with no UA at all |
| Max page size | **500** (`size: 500` → 500 results, 698 KB) |
| Cursor pagination | Unbounded in testing — walked 40 pages deep with no cap or degradation |
| Rate limiting | None observed: 10 sequential requests in 2.2 s, all `200` |
| Partitionable by | `category_id` (genre), `tag_norm_names`, `geoname_id` (location), `slice` |
| Coverage limitation | **Albums only.** Artists with only standalone tracks are absent |

### Per-item fields (exactly what Unstream needs)

`band_name`, `band_url`, `band_id`, `band_location`, `band_genre_id`, plus release-level
`title`, `item_url`, `release_date`, `price`, `track_count`, `featured_track` (with a streamable
mp3-128 URL), and `package_info` for physical formats.

Note `band_url` carries `?from=discover_page` — strip the query string.

### Partition sizes (sanity check that slicing works)

| Filter | `result_count` |
|---|---|
| unfiltered | 6,258,177 |
| `category_id: 2` | 238,655 |
| `tag: ambient` | 813,324 |
| `tag: black-metal` | 151,824 |
| `tag: shoegaze` | 104,594 |
| `geoname_id: 5128581` (NYC) | 124,041 |
| `geoname_id: 2643743` (London) | 43,102 |

### Unique-artist yield

Albums-per-request is not artists-per-request. Measured over 2,400 albums:

- `slice: "new"`, unfiltered → 1,894 unique bands (**79%**)
- `tag: "shoegaze"` → 1,461 unique bands (**61%**)

Yield decays with depth as you re-encounter prolific artists. Real artist count is likely in the
600k–1.5M range; the backfill should measure marginal yield directly and stop each partition at
diminishing returns rather than sweeping blindly to exhaustion.

## 4. Second find: a cheap existence oracle for the long tail

`HEAD https://<slug>.bandcamp.com/` is a reliable, zero-byte existence check:

| Outcome | Meaning |
|---|---|
| `200` | Account exists |
| `303` → `<slug>.bandcamp.com/album/…` | Exists (single-release artist, redirects to their one album) |
| `303` → `bandcamp.com/signup?new_domain=<slug>` | **Does not exist** |

Measured: `boyharsher`, `bigthief`, `tobyfox`, `explosionsinthesky`, `lowhum` → exist.
`mountaingoats`, `zzzzzznotarealartist12345` → `/signup` redirect.

**Identity must be verified separately.** A slug existing does not mean it's the right artist.
Artist pages embed:

```html
data-band="{&quot;id&quot;:2295933907,&quot;name&quot;:&quot;Boy Harsher&quot;}"
```

This caught a real false positive: `thebeths.bandcamp.com` returns `200`, but its `data-band` name
is `"no content"` — it is *not* The Beths. Slug-guessing without name verification would have
published a wrong link. Verified correct on `boyharsher` → "Boy Harsher", `bigthief` → "Big Thief",
`tobyfox` → "Toby Fox", `explosionsinthesky` → "Explosions in the Sky", `lowhum` → "Low Hum".

Artist pages return ~129 KB with any User-Agent (including none), and are not robots-disallowed.

## 5. Options assessed

| Option | Coverage | Policy | Effort | Verdict |
|---|---|---|---|---|
| **Discover-API index → local table** | Very high (~6.26M albums, albums-only) | Explicitly allowed | Medium | **Recommend — primary** |
| **Subdomain probe + `data-band` verify** | Fills long tail & track-only artists | Allowed | Low | **Recommend — fallback** |
| MusicBrainz / official-site links | Low-moderate (current state) | Fine | Already built | Keep as corroboration |
| Artist self-registration | Low, but highest-trust | Fine | Already built | Keep; not a coverage strategy |
| Per-artist `sitemap.xml` | Deep per-artist discography | Allowed & advertised | Low | Useful for *enrichment*, not discovery |
| Official Bandcamp API | None for this use case | Sanctioned | Low | **Rule out** — see below |
| Common Crawl backfill | Thin and shrinking | CCBot now `Disallow: /` | Medium | **Rule out** — see below |
| `/search` via TLS-fingerprint spoofing | High | Violates robots + defeats access control | Medium | **Rule out — will not build** |

### Why the official API doesn't help

`bandcamp.com/developer` is OAuth2 and gated to **labels and merch-fulfillment partners**. The
endpoints are Account, Sales Report, and Merch Orders — your own account's commercial data. There
is no catalog, search, or artist-lookup endpoint. It solves a different problem.

### Why Common Crawl doesn't help

`CCBot` is `Disallow: /` in current robots.txt, and CC honours it. Index blocks for
`*.bandcamp.com`: **71** in `CC-MAIN-2023-40` vs **6** in `CC-MAIN-2025-30` — roughly a 12×
decline. It's a shrinking historical snapshot, not a live source.

### Why I'm not building the `/search` bypass

Public write-ups describe defeating Fastly's JA3/JA4 TLS fingerprinting with `curl_cffi` or
`impit` to reach `/search`. I'm not going to implement that, for three reasons — and the third is
the one that matters:

1. `/search` is `Disallow`ed in robots.txt. Bypassing the challenge means overriding an access
   control Bandcamp deliberately placed on a path they'd already asked crawlers to skip.
2. It's an arms race. It breaks on their next fingerprint update, silently, exactly like the
   current scrape did.
3. **It's unnecessary and strictly worse.** The discover API is permitted, returns *more*
   structured data than the search page HTML, supports bulk enumeration, and doesn't need to be
   re-run per query. There's no coverage argument for the bypass.

## 5a. On-demand slug probing, measured

Brandon proposed skipping the bulk index: slugify the user's query, probe
`<slug>.bandcamp.com` on demand, store the result permanently. Demand-weighted, no constant
polling. Measured against ground truth (3,018 real artists sampled from discover, so their true
`band_url` is known):

### Recall

| Probes | Strategy added | Cumulative recall |
|---|---|---|
| 1 | `base` (lowercase, strip non-alphanumeric) | 66.3% |
| 2 | strip leading "the" | 69.3% |
| 3 | hyphenated | 71.1% |
| 7 | `…music`, `…official`, `official…`, `…band` | 73.9% |
| 11 | `first-2-words`, `…records`, `first-word` | 74.8% |

The curve flattens hard after probe 3. **Probes 4–11 buy 3.7 percentage points for 8× the load
and latency.** Two to three candidates is the sweet spot; more is waste.

String comparison understates real recall, because Bandcamp resolves some aliases itself. On a
random 60-artist sample of first-guess mismatches: 41.7% still resolved to the correct artist.
So **effective 1-probe recall ≈ 80%**, not 66%. Brandon's instinct is stronger than the naive
number suggests.

Note this is 80% of artists *who have their own subdomain*. Artists on a label subdomain are
structurally unreachable this way — no slug derived from the artist's name will find them.

### The problem: name verification is not sufficient

13.3% of wrong first-guesses resolve to a real but *different* artist. Worse, the failures cluster
on the biggest, most-searched names. Inspecting the obvious slug for well-known artists:

| Slug | `data-band` name | Albums | Tracks | Location | Reality |
|---|---|---|---|---|---|
| `beyonce` | "Beyonce" | 0 | 0 | — | **Empty squatter** |
| `sufjan` | "Sufjan" | 0 | 0 | — | **Empty squatter** |
| `jackwhite` | "Jack White" | 0 | 0 | — | **Empty squatter** |
| `officialjackwhite` | "Jack White" | 5 | 13 | Nashville, TN | Real Jack White |
| `nirvana` | "Nirvana" | 2 | 0 | Seattle, WA | Ambiguous — tribute or different band |
| `radiohead` | "Radiohead" | 0 | 12 | Oxford, UK | Plausible but sparse |
| `aphextwin` | "Aphex Twin" | 14 | 2 | UK | Real |
| `boyharsher` | "Boy Harsher" | 15 | 1 | Northampton, MA | Real |

A name check passes all of these. Searching "Beyoncé" or "Sufjan Stevens" would surface a parked
squatter account as a legitimate Bandcamp presence.

**Required guard: reject accounts with an empty catalog** (0 albums *and* 0 tracks). That filters
every squatter in the table. It does not resolve genuine same-name ambiguity (`nirvana`), which no
amount of probing can settle.

**The index does not have this problem at all.** Discover indexes *albums*, so an account with no
releases cannot appear in it — the index is squatter-free by construction. Discover correctly
returns `officialjackwhite`, never the empty `jackwhite`.

### Load: the intuition inverts

On-demand feels gentler, and per-unit-time it is. But in total volume:

- Full sweep: **~12,500 requests, once.**
- On-demand at ~2 probes per distinct new query: **crossover at ~6,000 distinct artist searches.**

Past roughly six thousand unique queries, on-demand has sent Bandcamp more requests than the
entire catalogue sweep would have — and it keeps growing, forever. Negative caching is therefore
mandatory, not an optimization: without it, every search for an artist who isn't on Bandcamp
re-probes on every single search, indefinitely.

### Location: a cost difference, not a capability difference

**Corrected 26 July.** An earlier version of this section claimed band pages expose location in
only 1 of 6 cases. That was a measurement error — it used `curl` without `-L`, so it never followed
the redirect that band roots issue, which is not what `globalThis.fetch` does (fetch follows
redirects by default).

Re-measured correctly on 20 artists from `slice: "new"`: **18/20 (90%)** of locations are
recoverable from the band page — 7 via JSON-LD, 11 via the `class="location"` regex fallback. The
two misses are artists for whom discover *also* reports no location.

Two page layouts exist, and the existing implementation already handles both:

- **Redirecting root** (`tobyfox`, `lowhum`, `radiohead`) — root 303s to a featured album/track,
  which carries JSON-LD with `foundingLocation`.
- **Discography-grid root** (`boyharsher`) — no JSON-LD at all, but the `class="location"` element
  is present and the regex fallback catches it.

So on-demand probing *can* supply location. The discover advantage is **cost**, not capability:
one request returns `band_location` for up to 500 artists, versus one page fetch per artist. That
still favours the index for bulk work, but it is not a blocker for Layer A.

## 5b. Cross-source release matching as a squatter filter

Brandon's proposed guard: check the candidate Bandcamp page has releases, and that those releases
match the artist's MusicBrainz entry (or another source such as Qobuz).

Tested by pulling release titles from `<slug>.bandcamp.com/music` (`<p class="title">` inside
`music-grid-item`) and comparing against MusicBrainz release-groups, with aggressive title
normalisation (strip parentheticals, "deluxe/remaster/edition/EP/soundtrack", non-alphanumerics).

### Where it works: excellently

| Slug | BC releases | MB status | Overlap | Verdict |
|---|---|---|---|---|
| `radiohead` | 15 | ok (100 rg) | **11** | ACCEPT — Radiohead *is* real on Bandcamp |
| `aphextwin` | 16 | ok (100 rg) | **11** | ACCEPT |
| `nirvana` | 2 | ok (100 rg) | **1** ("Bleach") | ACCEPT — resolves the ambiguous case |
| `officialjackwhite` | 5 | ok (87 rg) | **5** | ACCEPT |
| `boyharsher` | 16 | ok (18 rg) | **10** | ACCEPT |
| `beyonce` | 0 | absent | 0 | REJECT (empty) |
| `jackwhite` | 0 | ok (87 rg) | 0 | REJECT (empty) |

This settles `nirvana`, which the empty-catalogue check could not. Squatters cluster on famous
artists, and famous artists have excellent MusicBrainz coverage — the risk and the verification
data align well.

### Where it fails: the long tail, which is the whole point

Random 25-artist sample from `slice: "new"` (i.e. representative of the real long tail):

| MusicBrainz status | Count |
|---|---|
| present with releases | **2 / 25 (8%)** |
| **absent** | **22 / 25 (88%)** |
| unavailable / errored | 1 / 25 |

And of the two that *were* in MusicBrainz, **zero** had their current Bandcamp album title present
in MB.

**So a hard "must corroborate against MusicBrainz" rule would reject roughly 92% of long-tail
Bandcamp artists** — precisely the cohort this whole project exists to cover. The rule must be
asymmetric.

### Three states, not two

The verifier must distinguish *contradicted* from *unknown*:

| State | Condition | Action |
|---|---|---|
| **REJECT** | 0 albums and 0 tracks | Empty squatter. Cheap, no external call. |
| **ACCEPT** | ≥1 release corroborated by MB/Qobuz | High confidence. |
| **REJECT** | Has releases, external source has releases, **zero** overlap | Genuine mismatch. |
| **UNDECIDABLE** | External source absent **or unavailable** | **Accept on tier-2 signals. Never reject.** |

That last row is not a detail. While testing this I hit the failure myself: v1 of the harness
swallowed a MusicBrainz rate-limit into `rg_count = 0`, which became a false REJECT for Aphex Twin
— an artist with 119 release-groups in MB. **Identical failure class to the Bandcamp silent-200
bug**: treating "source unavailable" as "source says no". If this rule ships without the three-state
distinction, a MusicBrainz outage silently hides Bandcamp links site-wide.

### Practical constraint

MusicBrainz allows 1 request/second, and verification costs 2 calls (artist search +
release-groups). One `unavailable` appeared in 25 sequential calls. So cross-referencing **cannot
run inline** in a search request — it belongs in the existing Phase 2 background enrichment, which
already spaces MB calls at 1.1s.

### The reframe

Cross-referencing is a **resolver for ambiguous non-empty accounts**, not a general gate:

- The empty-catalogue check alone caught **every** squatter found (`beyonce`, `sufjan`, `jackwhite`)
  at zero external cost and zero coverage loss.
- Cross-referencing added value only for `nirvana` — non-empty, same-name, genuinely ambiguous.
- Applied as a general gate it would cost ~92% of long-tail coverage.

And note what this implies for Layer B: **the index needs no verification at all.** Discover
indexes albums, so an empty squatter cannot appear in it, and its records are authoritative. The
squatter problem is a Layer-A problem only.

## 5c. Layer A verified against live Bandcamp (26 July)

Running the shipped `probeBandcampArtist` against real Bandcamp, not a sample:

| Query | Verdict | Albums/Tracks | Result |
|---|---|---|---|
| Boy Harsher | `accepted` | 15/1 | `boyharsher` |
| Radiohead | `accepted` | 15/0 | `radiohead` |
| Sufjan Stevens | `accepted` | 15/1 | `sufjanstevens` |
| The Mountain Goats | `accepted` | 14/2 | `themountaingoats` |
| Explosions in the Sky | `accepted` | 13/0 | `explosionsinthesky` |
| Robyn Hitchcock | `accepted` | 16/0 | `robynhitchcock` |
| Nirvana | `accepted` | 2/0 | `nirvana` |
| **Beyonce** | `rejected_empty` | 0/0 | squatter caught |
| **Jack White** | `rejected_empty` | 0/0 | squatter caught (real one is `officialjackwhite`) |
| **Panda Bear** | `rejected_empty` | 0/0 | real one is `pandabearmusic` |
| **Butcher Brown** | `rejected_empty` | 0/0 | real one is `butcherbrownmusic` |
| **MESH** | `rejected_empty` | 0/0 | `mesh` is "M.E.S.H." with no releases; real one is `meshphilly` |
| **The Beths** | `rejected_name` | 0/0 | `thebeths` is "no content" |
| **King Gizzard & The Lizard Wizard** | `absent` | 0/0 | real one is the truncated `kinggizzard` |
| zzzznotarealartist999 | `absent` | 0/0 | correct |

Every failure mode declines cleanly. **No case returned a wrong URL** — the squatter gate and name
check between them turn every near-miss into an honest "nothing here" rather than a bad link.

### The §5a recall figures were an undercount

Several artists whose base slug §5a scored as a *miss* are in fact accepted here: `shearling`
(2 albums), `rezn` (3), `loathe` (6), `robynhitchcock` (16), `themountaingoats` (14),
`sufjanstevens` (15). The reason: **many artists hold more than one real Bandcamp account** — a
plain-name one and an `…official` / `…music` variant. §5a compared the generated slug against the
single URL discover happened to return, so a valid non-empty alternative counted as a failure.

This is the same effect as the 41.7% "mismatches that still resolved correctly" — not only
redirects, but genuinely multiple valid presences. Real-world accept rate is therefore at the
upper end of the 66–80% range, better for well-known artists.

**One honest consequence:** where both exist, Layer A may return the *secondary* account —
`shearling` (2 albums) rather than `shearlingofficial` (more). That's a valid page for the artist,
not a wrong answer, but it isn't necessarily their canonical or most complete one. Layer B's index
returns whatever discover considers canonical, which is another reason to check the index first and
fall back to probing, exactly as §6.4 orders it.

## 6. Recommended architecture

The shift is from **per-query live scrape** to **local index + live fallback**. This is faster and
more complete, not just more compliant — search stops making a 5-second outbound call.

Both layers are worth building, and they can ship in either order:

- **Layer A — on-demand slug probe** (§5a). Recovers ~80% of subdomain artists, ships in about a
  day, demand-weighted. Requires name verification *and* the empty-catalog guard. Misses
  label-hosted artists entirely and cannot supply location data.
- **Layer B — discover index** (§6.1–6.3). ~52 minutes of one-time work for authoritative,
  squatter-free coverage including label-hosted artists, plus `band_location` on every record.

Shipping A first is reasonable — it's fast and recovers most of the lost coverage immediately. But
B is what closes the gap on the "bigger artists" cohort and what makes the artist-location
database possible, so A is best understood as the fallback layer rather than the destination.

### 6.1 New Supabase table

```sql
create table if not exists bandcamp_artists (
  band_id      bigint primary key,          -- Bandcamp's stable numeric id
  slug         text not null,               -- "boyharsher"
  url          text not null,               -- "https://boyharsher.bandcamp.com"
  name         text not null,               -- "Boy Harsher"
  name_norm    text not null,               -- lowercased, punctuation stripped
  location     text,                        -- "Northampton, Massachusetts"
  genre_id     int,
  album_count  int default 0,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
create index if not exists bandcamp_artists_name_norm_idx on bandcamp_artists (name_norm);
create index if not exists bandcamp_artists_name_trgm_idx
  on bandcamp_artists using gin (name_norm gin_trgm_ops);   -- fuzzy match
```

Needs RLS (public read, service-role write) in a timestamp-prefixed migration per the repo
convention. Feeds the existing merge-override and disambiguation logic in
`api/functions/search-utils.ts`.

### 6.2 Backfill job (one-off, then retire)

Cost math at `size: 500`:

- 6,258,177 ÷ 500 = **~12,516 requests**
- ~1,395 bytes/album → **~8.7 GB** total transfer
- At a deliberately polite 4 req/s: **~52 minutes**

Bandwidth is the real cost, not request count, and it can't be reduced — there's no field
selection, and `discover_mobile_web` returns a byte-identical payload (confirmed: both 697,625
bytes for `size: 500`). This is a **GitHub Actions job, not a Netlify Function** — the 15-minute
function ceiling can't hold it. Chunk by genre × location partition, checkpoint the cursor, upsert
on `band_id`.

Start at 2–4 req/s with exponential backoff on any non-200, even though no rate limit was
observed. The absence of a limit in a 10-request sample is not a licence to hammer them.

### 6.3 Daily incremental (the part that keeps working)

`slice: "new"` is date-ordered. Walk it until you hit a page where every `band_id` is already
known, then stop. That's a few hundred requests a day and catches new artists as they release.

### 6.4 Search path

1. Look up `name_norm` in `bandcamp_artists` (exact, then trigram fuzzy). Instant, no outbound call.
2. On miss: generate slug candidates from the query (strip spaces/punctuation, try `the`-prefix
   variants), `HEAD`-probe each, verify `data-band` name against the query, cache the outcome —
   **including negatives**, so repeat misses cost nothing.
3. Keep MusicBrainz/official-site links as corroboration and for artists on label subdomains.

### 6.5 Fix the silent failure regardless

Whatever else gets built, `searchBandcamp` should treat "200 with zero parseable results" as
suspicious rather than authoritative — detect the challenge marker and report to Sentry. A source
that silently returns "no results" is worse than one that errors, because it can't be noticed.

## 7. Known gaps in the recommendation

Stating these plainly rather than discovering them later:

- **Track-only artists are invisible to discover.** `include_result_types` accepts only `["a"]`.
  The subdomain probe is the only path to them.
- **Label subdomains hide artists.** Discover surfaces these as the *label's* `band_name`, so
  artist-level attribution needs `album_artist` (present in the payload) as a secondary signal.
  (Correction: an earlier draft used The Mountain Goats as the example. That was wrong — probing
  the *base* slug `themountaingoats` finds them with 14 albums. The stripped-"the" variant
  `mountaingoats` is what 404s. Verified 26 July.)
- **Slug guessing has a real false-positive rate.** `thebeths` proves it. Name verification is
  mandatory, not optional.
- **The cursor is opaque and undocumented.** It could change shape without notice. Checkpoint by
  partition so a cursor break costs one partition, not the whole sweep.
- **This is all undocumented internal API.** It's robots-permitted, but it carries no stability
  promise. Expect to fix it periodically, and instrument it so breakage is loud.

## 8. Worth doing in parallel: just ask

Unstream sends buyers *to* Bandcamp and highlights their 100%-to-artist days. That's an unusually
easy conversation compared to most people asking them for data access. Worth an email to Bandcamp
describing the referral use case and asking whether they'd sanction catalog access or bless the
discover-API usage explicitly. Low cost, and a sanctioned integration would remove the "expect to
fix it periodically" caveat entirely.

Don't block the build on it.

## 9. Open questions for Brandon

1. ~~**Index scope**~~ — resolved 26 July: build both layers, on-demand probe first (§5a, §6).
2. ~~**Squatter filter**~~ — resolved 26 July: empty-catalogue check as the gate, cross-source
   matching as an ambiguity resolver in Phase 2 background enrichment, never as a hard gate (§5b).
3. **Fallback depth** — 2 or 3 slug candidates? Recall is 69.3% at two, 71.1% at three (before
   alias resolution). Each probe adds ~100 ms, and only on a miss. *Suggest 3.*
4. **Cross-ref rejections** — when an account has releases, MusicBrainz has releases, and **zero**
   overlap, silently hide it or route it to the existing `/admin/verify` queue? *Suggest
   `/admin/verify`* — it's a small volume and the failure mode is interesting.
5. **Refresh cadence** — is daily `slice: "new"` enough, or do you also want a periodic full
   re-sweep to catch renames and deletions? Renamed artists will otherwise go stale.
6. **Outreach** — want the Bandcamp email drafted alongside the implementation?

---

## 10. Coverage re-measured against real traffic (26 July, second run)

> The earlier §"coverage after #319" run sampled `data/artist-list.json` (Wikidata-notable artists)
> and got MusicBrainz 9% / Layer A 19% / either 21%. That sample over-represents major-label acts who
> were never on Bandcamp, so this run was scheduled to redo it against real search traffic. It also
> resolves the open `rejected_empty` question — and turned up two bugs that the earlier tests, which
> had no ground truth, could not have found.
>
> Bandcamp's rate limit had reset. **Zero 429s and zero `undecided` verdicts across ~200 requests**
> at 2.5s between artists. MusicBrainz was clean too: 0 `unavailable` in 69 artists at 1.35s spacing,
> versus 13% errors last time.

### 10.0 First: `app_events` does not store the query

The plan was to pull most-searched artist names from `app_events` where `event_type = 'search'`.
**That data does not exist.** 9,664 search events are stored, and the `context` column holds only
`{ has_results, result_count }` — the query string is deliberately never recorded
(`supabase/migrations/20260412000000_app-events.sql`, `apps/web/src/services/analytics.ts:75`).
That is a sound privacy choice, not a gap to fill, but it means **Unstream cannot currently answer
"what do people search for?" from analytics.**

Three imperfect proxies exist. All three are reported below, because they bracket the answer rather
than agree on it:

| Sample | n | What it actually is | Bias |
|---|---|---|---|
| **A** `data/artist-list.json` | 100 | Wikidata-notable artists | **Down.** Major-label acts, many never on Bandcamp |
| **B** `artist_analytics` `metric='search'` | 69 | Artists that appeared in results *and* have a claimed profile | **Up, strongly.** See below |
| **C** `bandcamp_slug_probes.query_norm` | 24 | **Literal queries users typed**, from the Layer A cache | Unbiased by construction, but tiny and partly my own test traffic |

**Sample B's bias is structural and large.** `trackArtistSearchAppearance` fires only when
`result.claimedSlug` is set (`apps/web/src/components/ResultCard.tsx:31`), so the table can only ever
contain artists who claimed an Unstream profile. Measured: **68 of the 69 are `source: 'claimed'`.**
Artists who find Unstream and claim a profile are overwhelmingly Bandcamp-native indies. Sample B is
therefore a near-best case, not a typical one.

**Sample C is the one to build on.** `bandcamp_slug_probes` is, as a side effect of #319, the only
place Unstream stores literal search text. It is small today (36 rows, ~a third of them my own
verification queries) but it accumulates. In a few weeks it is the clean instrument for this
measurement — no new tracking required.

### 10.1 Headline coverage, sample B (real traffic, claimed-artist cohort, n=69)

| Source | Found a Bandcamp URL | vs sample A |
|---|---|---|
| MusicBrainz `url-rels` | **24 / 69 = 35%** | 9% |
| Layer A probe | **55 / 69 = 80%** | 19% |
| **Either** | **59 / 69 = 86%** | 21% |
| Neither | 10 / 69 = 14% | 79% |

Attribution: 20 both · 4 MB-only · **35 probe-only** · **1 disagreement**.

Probe verdicts: 55 `accepted`, 8 `absent`, 6 `rejected_empty`, 0 `rejected_name`, 0 `undecided`.
MusicBrainz: 24 found, 26 no Bandcamp relation, 19 no artist match, 0 unavailable.

**Layer A's marginal gain over MusicBrainz alone is 35 artists — 51 percentage points**, versus the
12pp measured on sample A. On the cohort Unstream actually serves, the probe is not a supplement to
MusicBrainz; it is the primary source, and MusicBrainz is the supplement.

For sample C (literal typed queries, 24 rows after excluding known test queries): 9 accepted (37.5%),
9 absent, 6 `rejected_empty` — rising to ~46% once the false rejects in §10.3 are counted.

**So the honest range for "does Unstream find this artist on Bandcamp" is roughly 40–85%**, depending
on how indie the querying population is, with sample C's ~40% the closest thing to a typical figure
and 86% the ceiling for the claimed-artist cohort. **Do not quote a single number.**

### 10.2 Ground truth: 96% of this cohort *is* on Bandcamp

Sample B's artists are claimed profiles, so they have self-declared platform links in
`artist_links` — the artist's own statement of where they are. **66 of 69 (96%) declared a Bandcamp
URL.**

That converts the coverage figures into a recall figure against known truth:

| | of 66 artists known to be on Bandcamp |
|---|---|
| Layer A found them | 55 = **83%** |
| MusicBrainz found them | 24 = 36% |
| Layer A after the §10.3 fix | 58 = **88%** |

83% recall against ground truth is at the top of the 66–80% band §5a predicted, confirming the
"§5a undercounted" correction.

The 12 artists Layer A missed despite a self-declared Bandcamp page split into three groups, and the
split is what should decide Layer B:

| Miss type | Artists | Real slug vs. query |
|---|---|---|
| **Slug not derivable from the name** (6) | sknob, Court Lee, JAMIEvx, Stan Stewart (×2), M. Walker, Env!sioN | `vincentknobil`, `courstellation`, `diym`, `muz4now`, `schmeeglez`, `envis10n` |
| **False reject** (3) | Prairiez, Gizz Van Buskirk, bloodless girls | correct slug, wrongly scored 0/0 — §10.3 |
| **Variant slug + a same-name empty account** (3) | SideBanks, Trans Panic | real: `side-banks`, `transpanicpunk`; probe found empty `sidebanks`, `transpanic` |

**No slug heuristic will ever reach the first group.** `schmeeglez` for "M. Walker" is not a
transformation, it is a different word. That group — 6/69 ≈ **9% of traffic** — is precisely and only
what Layer B's index solves.

One small candidate-generation gap worth noting: `bandcampSlugCandidates('SideBanks')` returns just
`["sidebanks"]`. The hyphenated variant is derived from spaces, so camelCase names lose their word
boundary and never produce `side-banks`. Cheap to fix if it's worth it; low volume.

### 10.3 `rejected_empty`: the rate is real, but **38% of the rejections are false** — confirmed bug

The open question was whether the 34% `rejected_empty` rate on sample A hid false rejects. **It does.**

Checked 13 rejected accounts (6 from sample B, 7 real production rejections from the probe cache) by
re-fetching `/music` and comparing `parseBandcampReleaseCounts`'s view against raw hrefs:

| Slug | parsed | `music-grid-item` | album hrefs | Verdict |
|---|---|---|---|---|
| `prairiez` | 0a/0t | **0** | 8 | **FALSE REJECT** |
| `gizzvanbuskirk` | 0a/0t | **0** | 8 | **FALSE REJECT** |
| `bloodlessgirls` | 0a/0t | **0** | 7 | **FALSE REJECT** |
| `massive-attack` | 0a/0t | **0** | 11 | **FALSE REJECT** |
| `yoko-kanno` | 0a/0t | **0** | 11 | **FALSE REJECT** |
| `transpanic`, `sidebanks`, `johnnysycamore`, `pseudosun`, `beyonce`, `bonobo`, `chatgpt`, `tanerelle` | 0a/0t | 0 | 0 | genuine empty |

**5 of 13 = 38% of `rejected_empty` verdicts are wrong.**

**Mechanism — it is the redirecting-root layout §5a already documented, applied to counting rather
than location.** For a single-release artist, `/music` does not serve a discography grid:

```
GET https://prairiez.bandcamp.com/music
→ HTTP 303 → https://prairiez.bandcamp.com/album/subtitles-for-blushing
→ music-grid-item: 0        (the grid layout is absent entirely)
→ sidebar_disco: {"music_grid":true,"discography_real_size":1}
```

`parseBandcampReleaseCounts` only counts `.music-grid-item[data-item-id]`, so an artist whose
`/music` redirects to their one album scores 0 albums and 0 tracks and is classified as a parked
squatter. Then — and this is the damaging part — `rejected_empty` **is** a cacheable verdict, so the
false negative is written to `bandcamp_slug_probes` and persists.

**The fix is precise, and the two layouts are cleanly distinguishable.** Verified on 7 pages:

| Page shape | `music-grid-item` | `discography_real_size` |
|---|---|---|
| grid root (`boyharsher`, `stressdolls`) | 16, 12 | absent |
| redirected-to-album (all 5 false rejects) | 0 | **present, = 1** |

So: when the counts come back 0/0, check for `discography_real_size` (or equivalently for a
`data-tralbum` album page) before concluding the account is empty. This is a parser-level change in
`parseBandcampReleaseCounts` plus a unit test per layout — no new requests, since the page is already
in hand.

**Cost of not fixing it:** 3pp of coverage on sample B, and it lands hardest on single-release
artists — the exact long-tail cohort the project exists for. It also silently drops **Massive
Attack** and **Yoko Kanno**, so it is not only a long-tail problem.

### 10.4 New finding: Layer A returns the *wrong artist* about 4% of the time

§5c concluded "No case returned a wrong URL." **That was true of the cases tested, and it is wrong as
a general claim** — those tests had no ground truth to check against. Comparing the probe's answer to
the artist's own declared link, 3 of 69 (4.3%) disagree, and in each case the probe has found a
different act with the same name:

| Unstream artist | Artist's own link | Probe returned | Reality |
|---|---|---|---|
| **Tear** | `tearperth` — "Tear", **Perth, Australia**, 11 releases | `tear` — "TeaR", **Tangerang, Indonesia**, 2 releases | **Wrong artist.** Perth matches the artist's stored city |
| **Bonsoir** | `lifestylers` — "Lifestyler Music", 16 releases | `bonsoir` — "Bonsoir", **San Diego CA**, 7 releases | **Wrong artist** (different act, same name) |
| **Abhorrence** | `abhorrencefin` — "Abhorrence", **Helsinki**, 4 releases | `abhorrence` — "Abhorrence", **Elizabethtown PA**, 7 releases | Genuine same-name ambiguity, two real bands |

Both guards behave exactly as designed and both are satisfied: the name matches, and the account is
non-empty. **Neither guard can catch this, because the failure is not squatting — it is two real
artists sharing a name.** This is the `nirvana` case from §5b, now measured at ~4% of accepted
results rather than assumed rare.

This is the strongest argument yet for §5b's cross-source resolver, and for §6.4's ordering (index
first, probe second). Discover returns whatever Bandcamp treats as canonical for the *indexed*
artist; slug-guessing returns whoever holds the shortest slug.

#### Correction (checked 2026-07-27): none of these three reach users

The paragraph above originally ended by warning that Unstream was "showing three of its own claimed
artists a stranger's Bandcamp page," and recommended making `artist_links` outrank the probe. **That
was asserted, not tested, and it is wrong.** Queried against production:

```
/api/search/sources?query=Tear        → claimed "Tear"       → tearperth.bandcamp.com
/api/search/sources?query=Bonsoir     → claimed "Bonsoir"    → lifestylers.bandcamp.com
/api/search/sources?query=Abhorrence  → claimed "Abhorrence" → abhorrencefin.bandcamp.com
```

All three already return the artist's own declared link and nothing else. **Two independent
mitigations were already in place**, and between them they cover every case where a fix is even
possible:

1. **Claimed artists** (`api/functions/search-sources.ts`) — a claimed DB record is prepended to the
   results and live results matching its name are filtered out, so the probe's card is dropped
   entirely. This is why all three examples are clean.
2. **MusicBrainz relations** (`apps/web/src/services/sources.ts`) — Phase 2 *replaces* any existing
   Bandcamp platform with MB's relation URL. So even unclaimed, `abhorrence` would be corrected to
   `abhorrencefin` about a second after Phase 1 paints.

**So the residual exposure is precisely: unclaimed artist + no MusicBrainz Bandcamp relation +
same-name collision.** Tear and Bonsoir both sit in that set (`no_bandcamp_rel`) and are only saved
by being claimed. That intersection has no free signal in it — by definition no source has an
opinion — so there is nothing cheap left to build. The options are §5b's cross-source resolver
(release-title overlap, Phase 2, routed to `/admin/verify`) or Layer B's index.

The one thing worth doing immediately was cheap: mitigation 2 survived only as a side effect of a
comment describing the *old* disabled scraper ("MB relations are our primary source for direct
Bandcamp links" — no longer true; the probe finds 80% versus MB's 35%). A refactor reading that
comment could reasonably have downgraded the overwrite to a fill-in-if-missing and silently
reintroduced the bug. The comment now states why the overwrite is load-bearing.

**Method note.** This is the second time in two days that a mechanism was named as a cause before
being tested — see the Anna von Hausswolff sequence. The check took one `curl` per artist.

### 10.5 Layer B scope: full sweep, but **not next**

The question was full 6.26M-album sweep versus a targeted seed from the genres and locations real
traffic hits. **A targeted seed will not work, and the full sweep is not the highest-value next
step.**

**Why a targeted seed fails.** Layer B's only unique job is the 6 non-derivable-slug artists in
§10.2 — nothing else in the residual needs an index. Those artists are not clustered: within a
69-artist sample the relevant locations are San Diego, Perth, Helsinki, Tangerang, Elizabethtown PA,
and 50 of 69 have no location recorded at all. Slug non-derivability is a property of how an
individual artist named their account, and is uncorrelated with genre or geography. There is no small
set of partitions that captures it, so a seed would deliver an unknown and unmeasurable fraction of
a 9% gain. Partition the sweep for **checkpointing** (§6.2), not for scope.

**Why it is not next.** Ranked by value per unit of work:

| Work | Gain | Cost |
|---|---|---|
| 1. Fix the false-reject parser (§10.3) | +3pp, and stops caching false negatives | hours; no new requests |
| 2. ~~Prefer self-declared `artist_links`~~ | — **already in place**, see the §10.4 correction | done |
| 3. Cross-source resolver for same-name ambiguity (§5b) | the only remaining lever on the ~4% wrong-artist rate | days |
| 4. **Layer B full sweep** | **+9pp (non-derivable slugs), plus canonical-URL preference and bulk `band_location`** | ~12,500 requests, ~8.7 GB, plus permanent maintenance |

Item 1 recovers more correctness per hour than anything else here and adds zero load to Bandcamp.
Item 2 turned out to need no work. Layer B's real justification is not raw coverage — Layer A already
achieves 83% recall against ground truth — it is **name→canonical-URL resolution**, which is also
what fixes the wrong-artist class properly and what makes the artist-location database possible.

**Recommendation: do 1, then decide between 3 and 4** — they attack the same residual from different
directions, and 4 subsumes 3 for any artist that has albums in the index. And revise
§6.2's throttling assumptions — Bandcamp *does* rate-limit (429), which the original 10-request
sample missed. Budget for `Retry-After` backoff and resumable per-partition checkpoints, and treat
4 req/s as an untested ceiling rather than a plan.

### 10.6 Measurement notes for whoever re-runs this

- **Throttling that worked:** 2.5s between artists (each artist may fire up to 3 requests inside one
  `probeBandcampArtist` call), abort the whole run on the first `undecided`. ~200 requests, no 429s.
  MusicBrainz at 1.35s spacing with up-to-3 retries on 503: 0 unavailable in 138 calls.
- `probeBandcampArtist` writes nothing to Supabase — only `findBandcampArtist` does. Use the former
  for measurement so the run cannot poison the production probe cache.
- **Layer A's URL does reach users.** Confirmed live during this run:
  `GET /api/search/sources?query=radiohead` returns a platform with `sourceId: "bandcamp"` and
  `radiohead.bandcamp.com`, and the result `imageUrl` is `f4.bcbits.com` (Bandcamp art). The
  "probe URL is discarded" defect was real in #319 and was fixed in #320; coverage figures here are
  user-visible, not theoretical.
- Searching MusicBrainz by artist name alone matches on name only, so it can return a *different*
  artist (it gave `abhorrencefin` for the Pennsylvania Abhorrence). Production goes through
  `search-musicbrainz.ts`'s own disambiguation; a name-only harness will slightly overstate MB
  disagreement.
