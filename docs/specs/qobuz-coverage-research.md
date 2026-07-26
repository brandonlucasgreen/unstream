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

## 7. Implementation plan (not yet done)

PR #325 has landed, so artist photos now come from Bandcamp and the removal is unblocked.

> **Read this first.** An automated attempt at step 2 corrupted both files. A brace-walking script
> mis-identified function boundaries — braces inside strings and regexes — reported
> `searchQobuz: 1 line` for a 95-line function, and produced 31 syntax errors. It was reverted; main
> is clean.
>
> **`search-sources.ts` (~2,050 lines) and `search-utils.ts` (~900 lines) must be hand-edited.** Do
> not script structural edits to them. This is the second scripted-edit failure in these two files;
> the first injected a variable into six unrelated `catch` blocks.

Line numbers below are against `0845da2` (main after #325). Verify them before editing.

### Step 1 — Attach MusicBrainz's Qobuz URL (do this FIRST)

**Why first:** `mbData.platformUrls` is currently used only for *disambiguation*
(`search-sources.ts:1617`) and never attached as a platform. Removing the search without this makes
Qobuz **disappear** rather than narrow to major artists. Ship the two steps together; if they must be
split, this one goes first.

In `applyEnrichmentToResults`, immediately before the `// Add Subvert URL from MB platform relations`
block (`search-sources.ts` ~1719), mirroring the Bandcamp block directly above it at 1704:

```ts
// Add Qobuz URL from MB platform relations. This is now the ONLY source of Qobuz links:
// the dedicated search hit /*/search/artists/, which is Disallow'ed in Qobuz's robots.txt,
// and artist URLs need an unguessable numeric ID so there is no probe fallback.
// MusicBrainz relations are authoritative, so no release verification is needed.
const qobuzUrl = mbData.platformUrls.find(u => {
  try { return new URL(u).hostname.endsWith('qobuz.com'); } catch { return false; }
});
if (qobuzUrl && !newPlatforms.some(p => p.sourceId === 'qobuz')) {
  newPlatforms.push({ sourceId: 'qobuz' as SourceId, url: qobuzUrl });
}
```

`endsWith('qobuz.com')` deliberately covers both shapes MusicBrainz uses —
`www.qobuz.com/us-en/interpreter/…` and `open.qobuz.com/artist/…`.

This edit was written and verified before the revert; it is known good.

### Step 2 — Remove the robots-disallowed Qobuz search

Delete, in `api/functions/search-sources.ts`:

| What | Lines | Note |
|---|---|---|
| `getQobuzLatestRelease` | 265–389 | 125 lines |
| `getQobuzReleaseTitles` | 391–442 | 52 lines |
| `searchQobuz` | 1123–1217 | 95 lines — the robots-disallowed fetch |
| `searchQobuz(query),` in the fan-out | 1775 | |
| `['qobuz', qobuzResults],` | 1790 | |
| `const qobuzMatches = …` | 1824 | |
| `createQobuzOnlyResults(aggregated, qobuzMatches);` | 1833 | |
| `createOrphanedQobuzStandalones(aggregated, qobuzMatches);` | 1914 | easy to miss — it is far below the others |

Also remove `qobuzResults` from the `Promise.allSettled` destructuring at ~1774 (the array is
positional — miscounting here silently shifts every other platform's results, so re-check each name
against its `searchX(query)` call).

Replace the Qobuz block in `fetchReleasesForDisambiguation` (~1401) with a comment. **Useful side
effect:** with no Qobuz platform ever entering the `completed` set, #324's guard means
`removeDeadQobuzLinks` now *keeps* MB-sourced links instead of deleting them for having no release
data. That is the desired behaviour and the reason #324 turned out to be worth merging after all.

In `api/functions/search-utils.ts`:

- `attachQobuzAndSearchLinks` (467–537) → rename to `attachSearchLinks`; drop the `qobuzMatches`
  parameter and the Qobuz-attaching branch at 517–528. Keep everything else — it also attaches
  Ampwall, Ko-fi, Buy Me a Coffee and the Bandcamp fallback link.
- Delete `createQobuzOnlyResults` (539–578) and `createOrphanedQobuzStandalones` (692–733).
- **Keep** `removeDeadQobuzLinks` (610), `isQobuzVariation` (364) and `qobuzDisplayName` (395) for
  now — they are harmless, and deleting them plus their tests is pure cleanup that does not need to
  ride along with a behaviour change.

### Step 3 — Tests

`apps/web/tests/unit/disambiguation.test.ts` and `identifiers.test.ts` reference the removed
functions. Expect to delete the `createQobuzOnlyResults` describe block (~336) and update the
`attachQobuzAndSearchLinks` call at ~291 to the new name and signature.

### Verification

`api/tsconfig.json` covers only six files, so **`npm run build` will not typecheck any of this.** Use
the explicit baseline:

```bash
npx tsc --noEmit --strict --target ES2022 --lib ES2022 --module ESNext \
  --moduleResolution bundler --types node --skipLibCheck --verbatimModuleSyntax \
  --moduleDetection force --noUnusedLocals --noUnusedParameters \
  api/functions/search-sources.ts api/functions/search-utils.ts
```

Main's baseline is **28 errors**. Any number above that is yours. Then `npx tsc -b`,
`npx vitest run api/functions/`, `npm run test:unit`.

Finally, confirm the outcome against real artists — a major-label artist should keep a Qobuz link via
MusicBrainz, and an indie artist should simply not have one:

```
/api/search/sources?query=Radiohead    -> expect a qobuz platform (MB relation)
/api/search/sources?query=Low%20Hum    -> expect no qobuz platform, and that this is correct
```

Both should have an artist photo from Bandcamp regardless.

## 8. Later

1. **Measure Wikidata `P7071` coverage** against real search traffic before adding it as a second
   source. The properties exist (`P7071`, `P11578`) and Unstream already pulls from Wikidata, but
   coverage is unmeasured — a spot check on one entity did not find it.
2. **Consider asking Qobuz** about sanctioned access, as with Bandcamp.
3. Delete `removeDeadQobuzLinks`, `isQobuzVariation`, `qobuzDisplayName` and their tests once the
   removal has settled.
