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
- **Label subdomains hide artists.** `mountaingoats.bandcamp.com` doesn't exist because The
  Mountain Goats release on a label's subdomain. Discover surfaces these as the *label's*
  `band_name`, so artist-level attribution needs `album_artist` (present in the payload) as a
  secondary signal.
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
