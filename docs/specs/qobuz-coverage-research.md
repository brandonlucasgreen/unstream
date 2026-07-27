# Qobuz Coverage: Research & Decision

> Status: **Done — dedicated Qobuz search retired** (26 July 2026). All findings below were
> verified empirically against live Qobuz endpoints on that date. This is the companion to
> `bandcamp-coverage-research.md`; the story rhymes, but the ending is different.
>
> Qobuz remains a supported platform. What was removed is the *scraping*; what replaced it is
> a MusicBrainz relation. See §7 for exactly what shipped.

## 1. How this surfaced

Brandon reported that Anna von Hausswolff's card had gained a working Bandcamp link but lost her
**artist photo** and **Qobuz link**. The report arrived minutes after a Bandcamp PR deployed, which
sent the investigation down three wrong paths before the decisive test was run.

That test — query artists nobody had searched that day — took ninety seconds:

| Query | Qobuz link | Artist photo |
|---|---|---|
| Portishead | missing | missing |
| Massive Attack | missing | missing |
| Bonobo | missing | missing |
| Four Tet | missing | missing |
| Radiohead | **present** | **present** |

**Qobuz was failing for every artist**, not one. Radiohead was the anomaly — almost certainly a
stale successful cache entry. The problem was systemic, pre-existing, and unrelated to the Bandcamp
work.

Lesson recorded separately: establish blast radius before hypothesising cause. Timing coincidence is
the weakest evidence of causation, and it is the evidence most available right after a deploy.

## 2. What Qobuz's robots.txt permits

`searchQobuz` fetched `https://www.qobuz.com/us-en/search/artists/{query}`. From
`https://www.qobuz.com/robots.txt`:

```
User-agent: *
...
Disallow: /api.json/
Disallow: /*/search/albums/
Disallow: /*/search/tracks/
Disallow: /*/search/labels/
Disallow: /*/search/artists/     <-- exactly the path we were scraping
Disallow: /player/
Disallow: /v4/
```

So the search path was **never permitted**, exactly as with Bandcamp's `/search`. The block just
started being enforced.

Artist pages (`/us-en/interpreter/...`) are **not** disallowed.

Worth noting Qobuz draws a thoughtful distinction the rest of the industry mostly doesn't —
interactive assistants are welcome, training crawlers are not:

```
User-agent: ChatGPT-User
User-agent: Perplexity-User
User-agent: Claude-User
Allow: /

User-agent: GPTBot
User-agent: ClaudeBot
User-agent: anthropic-ai
User-agent: CCBot
User-agent: Google-Extended
...
Disallow: /
```

## 3. Why the Bandcamp playbook does not transfer

The Bandcamp fix worked because artist URLs are **guessable**: `<slug>.bandcamp.com`. Qobuz URLs are
not.

```
/us-en/interpreter/radiohead          -> HTTP 404
/us-en/interpreter/radiohead/43840    -> HTTP 200
/us-en/interpreter/portishead         -> HTTP 404
```

The numeric ID is required and cannot be derived from the artist name. **There is no probe fallback
for Qobuz.**

Other doors, all closed:

| Route | Status |
|---|---|
| `/*/search/artists/` | `Disallow` |
| `/api.json/` | `Disallow` |
| `open.qobuz.com/artist/…` | separate host, `User-Agent: * / Disallow: /` |
| `/us-en/interpreter/{slug}/{id}` | **permitted**, but needs an ID you cannot guess |

Not a User-Agent issue either — an honest `Unstream/1.0` UA and a browser UA both return HTTP 200
with identical bodies (256,384 vs 256,385 bytes, 3 interpreter links each) from a residential IP.
The production failure is therefore most likely datacenter-IP enforcement, again mirroring Bandcamp.

## 4. The permitted route: metadata sources

Since the artist URL cannot be guessed, it has to come from somewhere that already knows it.

**MusicBrainz `url-rels`** — robots-clean, already integrated, and restored by PR #318:

```
Radiohead   https://www.qobuz.com/us-en/interpreter/radiohead/43840
Portishead  https://www.qobuz.com/us-en/interpreter/portishead/41259
Aphex Twin  https://open.qobuz.com/artist/53267
```

3/3 on the mainstream artists checked. Note two URL shapes — `www.qobuz.com/us-en/interpreter/…`
and `open.qobuz.com/artist/…` — so normalisation is needed, and the `open.` form points at a host
whose robots.txt disallows crawling (fine as a *link*, not as something to fetch).

**Wikidata** has two relevant properties:

- `P7071` — Qobuz artist ID
- `P11578` — Qobuz artist numeric ID

Unstream already pulls from Wikidata for `data/artist-list.json`, so this is a natural second source.
**Coverage is unmeasured** — a spot check on one entity did not find the property, though that entity
may have been wrong. Worth measuring before relying on it.

**Qobuz partner API** — `/api.json/` is robots-disallowed, but Qobuz runs a partner programme. Worth
asking, same as for Bandcamp.

## 5. Decision

**Retire dedicated Qobuz search.** Rely on MusicBrainz (and possibly Wikidata) to supply Qobuz links
where they exist.

Brandon's reasoning, which is the deciding factor: *"most indie artists don't even know or care
about Qobuz, it's really meant as a fallback for major artists who don't have music available on
Bandcamp or elsewhere."*

That makes the coverage profile of metadata sources — strong for well-known artists, thin for the
indie long tail — a **good fit** rather than a compromise. MusicBrainz covered only ~8–9% of
long-tail Bandcamp artists, but the long tail is not who Qobuz is for.

### Consequences

1. **The artist image needed a new source.** It came from the Qobuz match
   (`result.imageUrl = qobuzData.imageUrl`), which is why no artist currently has a photo. Bandcamp
   now supplies it from the `og:image` on the `/music` page the probe already fetches — verified
   band-level, and it matches the image production already shows for Radiohead. **PR #325.**

2. **The Qobuz validators become unnecessary and harmful.** `removeDeadQobuzLinks` and
   `crossPlatformReleaseComparison` exist to check *name-matched guesses* from the search. Once
   Qobuz links come only from MusicBrainz relations — authoritative by construction — those
   validators have nothing legitimate to filter, and would delete good links for having no release
   data behind them.

   This also **moots PR #324**, which fixed those validators' timeout behaviour. It should be closed
   rather than merged.

3. **Qobuz becomes a mainstream-only platform** in results. That is the intended outcome, not a
   regression.

## 6. Related work from the same investigation

Three real bugs were found and fixed while chasing this. None of them was the cause, and that is
worth recording so the next person does not re-litigate them:

| PR | Bug | Status |
|---|---|---|
| #322 | Bandcamp release fetches crowded the shared 4s budget | merged |
| #323 | Failed platform searches cached for 30 min as "artist not on this platform" | merged |
| #324 | Qobuz link deleted when its release lookup merely timed out | merged, then removed by §7 |
| #325 | Artist photo sourced from Bandcamp instead of Qobuz | merged — landed first, so photos survived |

## 7. What shipped

`pickQobuzUrl` in `api/functions/search-utils.ts` is now the entirety of Qobuz coverage: it reads
the Qobuz link out of MusicBrainz's `url-rels` (relation type `purchase for download` / `streaming`,
already collected into `platformUrls`) and prefers the `www.qobuz.com/.../interpreter/...` form over
`open.qobuz.com/artist/...` when MB stores both, which it often does. It is attached in
`applyEnrichmentToResults` and in the Phase-2.2 MB-fallback result, and mirrored client-side in
`mergeWithMusicBrainzData` for the deferred-enrichment path.

Removed, in order of how much complexity each carried:

- `searchQobuz` (both the cached Netlify-function copy and the dev-server copy), its Phase-1 fan-out
  slot, and its Sentry monitoring entry.
- The three Qobuz release scrapers — `getQobuzLatestRelease`, `getQobuzAlbumReleaseDate`,
  `getQobuzReleaseTitles` — and the Qobuz branch of `fetchReleasesForDisambiguation`, which no
  longer needs to report which lookups finished.
- Six validators that existed only to police name-matched guesses: `removeDeadQobuzLinks`,
  `crossPlatformReleaseComparison`, `deduplicateQobuzUrls`, `createOrphanedQobuzStandalones`,
  `createQobuzOnlyResults`, `preferBandcampFeaturedRelease`. An MB relation is authoritative by
  construction, so all six would only ever have deleted good links.
- `isQobuzVariation`, `qobuzDisplayName`, `parseQobuzSearchResults`, the `AggregatedPlatform` type,
  and the Qobuz branch of `extractPlatformIdentifier`.
- `checkQobuz` in `check-releases.ts` (it searched the robots-disallowed `/us-en/search/albums/`),
  plus Qobuz from the Mac app's and the extension's release-check platform lists. The unused
  `QobuzReleaseChecker.swift` went with it.
- `www.qobuz.com` from `ALLOWED_OUTBOUND_HOSTNAMES`. Nothing fetches Qobuz now, and least
  privilege means a future scraper has to be a deliberate decision rather than an accident.

Net: ~700 lines out of the search pipeline. Deliberately kept: the platform registry entry, payout
percentage, badges, the claim-flow URL pattern, extension detection, and the user-facing "search
Qobuz" link — a human clicking a search URL is not a crawler.

### Verification, and two bugs the fixtures were hiding

The integration suite (`npm run test:integration`) went from 4 failures to 8 on this change. I first
read that as "these two fixtures only ever passed on a residential IP." **That was wrong**, and both
new failures turned out to be real bugs with nothing to do with Qobuz. Recorded in full because the
wrong diagnosis is instructive.

**1. `Morice` was a misspelling — the artist is `Mo-Rice`.** Brandon caught it. The account is
`mo-rice.bandcamp.com`, HTTP 200, band name `Mo-Rice`, **16 releases**. `morice.bandcamp.com` is a
404. `bandcampSlugCandidates` handles this correctly — `"Mo-Rice"` yields
`["morice", "mo-rice"]`, so the hyphenated form is candidate 2 and the probe accepts it. The fixture
now asserts `bandcamp` + `urlPatterns.bandcamp: mo-rice.bandcamp.com`, which pins that behaviour.

**But production still returns 0 for `Mo-Rice`, and the cause is cache poisoning.** The probe cache
key is `normalizeForComparison(query)`, which strips the hyphen — so `"Mo-Rice"` and `"Morice"` share
the key `morice`. `"Morice"` generates only *one* candidate (`morice`, a 404), so it records
`verdict: 'absent'`, and `absent` is cached **permanently** (only `undecided` is skipped). Every
subsequent `"Mo-Rice"` search hits that row and returns null **without ever trying
`mo-rice.bandcamp.com`**. Years of the misspelled fixture running against production wrote the row
that now hides the real artist.

Generalised: **any punctuated artist name is unreachable if the unpunctuated spelling was searched
first.** `Ben-G!` has the identical shape (`beng` → `ben-g`). Logged in §8.

**2. `Tanerélle` exposed an accent bug that silently killed MusicBrainz enrichment for every accented
name.** `searchMusicBrainz` hand-rolled its name check as
`.toLowerCase().replace(/[^a-z0-9]/g, '')`, which **deletes** an accented letter instead of folding
it. MB returns `Tanerélle` → `tanerlle`; the query arrives already accent-normalized as `Tanerelle` →
`tanerelle`. No match, so the function bailed to `emptyResult` with the log line
`[MusicBrainz] Skipping "Tanerélle" - doesn't match query "Tanerelle"` — discarding official site,
Discogs, socials, Wikipedia, location **and the new Qobuz link**, for every accented artist.

Fixed here in both copies (`search-sources.ts` and `search-musicbrainz.ts`) by calling
`normalizeForComparison`, which folds accents via NFD. `normalize.test.ts` gained a regression test
contrasting the two so the inline version is not reintroduced. Tanerélle now returns a result with
her Discogs and Instagram links.

Her Bandcamp page is worth noting separately: `tanerelle.bandcamp.com` resolves with the correct band
name but holds **zero releases**, so the probe rejects it as `rejected_empty` — correct behaviour,
the same guard that keeps the empty `beyonce` / `sufjan` / `jackwhite` accounts out of results.

**Net:** the suite is back to its pre-change **4 failures** (Matt Young ×2, Ben-G!, French Montana —
all pre-existing; French Montana's is just a missing local `ALGOLIA_API_KEY`), plus Radiohead flaking
on MusicBrainz throttling.

**The real lesson** is not the one I first wrote down. It is: when a change makes tests fail, get a
`git stash` baseline *and* check production, then diagnose each failure individually rather than
reaching for one story that covers them all. A single explanation for four failures was the tell that
I had stopped looking.

Radiohead's `requiredPlatforms: ["bandcamp", "qobuz"]` fixture passes *because* of the new MB path
rather than a stale cache entry, which makes it the regression test for this change.

One caveat on it: it is flaky in a full-suite run, because MusicBrainz answers `503` when the suite
fires twenty searches at it back to back. It passed 2-of-3 in isolation
(`npx vitest run tests/integration -t "Radiohead"`), always failing with
`MusicBrainz artist search failed: 503`, and the failing run's platform list is missing Discogs too —
the signature of MB enrichment not landing at all. That is MB throttling, not the code.

It does mean Qobuz coverage now rests entirely on MusicBrainz being reachable. The important
property is that this degrades safely: `searchMusicBrainz` is deliberately *not* wrapped in
`cacheGetOrFetch`, so a 503 costs one request its Qobuz link and never gets written down as "this
artist has no Qobuz link" — the failure mode #321 and #323 were about.

## 8. Remaining work

1. **Bandcamp probe cache poisoning on punctuated names.** `bandcamp_slug_probes` is keyed on
   `normalizeForComparison(query)`, which strips the punctuation that *generates* the extra slug
   candidate. So `"Morice"` (one candidate, 404, cached `absent` forever) permanently hides
   `"Mo-Rice"` (two candidates, the second of which is a live account with 16 releases). Same shape
   for `Ben-G!` → `beng` / `ben-g`.
   - **Immediate unblock:** `delete from bandcamp_slug_probes where query_norm = 'morice';`
   - **Real fix:** store the candidate list that was actually probed and treat a cached negative as a
     miss when today's candidate set contains a slug that was never tried. Needs a migration, so it
     wants its own PR.
2. **Measure Wikidata `P7071` coverage** against real search traffic before deciding whether to add
   it as a second source. MB alone went 3/3 on the mainstream artists checked, so this is an
   improvement, not a gap.
3. **Consider asking Qobuz** about sanctioned access, as with Bandcamp.
