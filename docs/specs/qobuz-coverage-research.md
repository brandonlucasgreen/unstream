# Qobuz Coverage: Research & Decision

> Status: **Decided — retire dedicated Qobuz search** (26 July 2026). All findings below were
> verified empirically against live Qobuz endpoints on that date. This is the companion to
> `bandcamp-coverage-research.md`; the story rhymes, but the ending is different.

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
| #324 | Qobuz link deleted when its release lookup merely timed out | **close — mooted by this decision** |
| #325 | Artist photo sourced from Bandcamp instead of Qobuz | open |

## 7. Remaining work

1. **Remove `searchQobuz`** and the fan-out entry, plus the now-dead validators and Qobuz release
   fetchers. Depends on #325 landing first so photos survive.
2. **Attach MusicBrainz's Qobuz URL as a platform.** It is currently used only for disambiguation
   (`search-sources.ts` ~1617), never attached — so removing the search without this would drop
   Qobuz entirely.
3. **Measure Wikidata `P7071` coverage** against real search traffic before deciding whether to add
   it as a second source.
4. **Consider asking Qobuz** about sanctioned access, as with Bandcamp.
