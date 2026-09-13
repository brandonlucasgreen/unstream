# Engineering history: the evidence behind the rules

`CLAUDE.md` states the rules this codebase runs on. This file holds the measurements,
incidents and abandoned approaches that produced them — the *why*, at the length the why
actually needs. Each section here is referenced from the corresponding section of
`CLAUDE.md`.

Read this when you are about to change one of those rules, or when a rule looks arbitrary
and you want to know what it cost to learn. **Treat every number as a dated measurement,
not a current count** — re-measure before reasoning from one.

Related, more specific documents:

- `docs/specs/supabase-disk-io-investigation.md` — the full disk I/O investigation, confirming SQL, escalation ladder
- `docs/specs/bandcamp-coverage-research.md` — Bandcamp discovery research; §1 confirms the dead `api/search/` files
- `docs/postmortems/UNS-100-bifurcation-retro.md` — the two-renderers-for-one-URL bug loop (UNS-70/71/73/94/97/99/100)
- `docs/postmortems/2026-06-28-pr295-migrations-not-deployed.md` — migrations that didn't deploy
- `docs/postmortems/2026-08-01-sentry-silent-and-artist-pages-404.md` — silent Sentry, 404ing artist pages
- `apps/mac/docs/sparkle-updates.md` — Sparkle signing and sandbox detail

---

## Build order: the sitemap that shipped nothing for four weeks

**Rule it produced:** every generator must run before `vite build`.

`publish` is `apps/web/dist`, and `vite build` populates it by copying `apps/web/public/`.
So anything written to `public/` *after* `vite build` lands in a directory Netlify never
publishes.

The sitemap step used to run last. `apps/web/public/sitemap.xml` was therefore regenerated
on every build and then thrown away, and production served the last *committed* copy
instead — frozen at 2026-08-01 for four weeks. The generator's own "stop listing URLs that
404" logic (#385) never once took effect in production during that window.

The symptom is invisible in the build log: the generator prints a cheerful success either
way. Verify by diffing the deployed artifact against the committed file, never by reading
the log.

---

## Redis is metered: how the command budget was exhausted

**Rules it produced:** every extra limiter has to earn its round trip; batch reads that
share a request; never spend two commands answering one question; don't cache a constant.

Upstash's free tier is 500,000 commands a month (~16,600/day). It is a *command* budget,
not a bandwidth or storage one. The site went through it in August 2026 at genuinely low
traffic, because nothing here is expensive per request — there are just a lot of small
requests, each paying a fixed Redis tax before doing any work.

The arithmetic that matters, per user search:

| Step | Requests |
|---|---|
| Typeahead, on every debounced typing pause | 4-5 |
| `/api/search/sources` | 1 |
| `/api/search/musicbrainz` | 1 |
| Analytics POSTs | 2-3 |
| Artist page | 1 |
| **Total** | **~10** |

*Every one* of those went through `checkRateLimit`. So per-request overhead is multiplied
by ten before a single search happens.

### Why only `strict` has a daily quota

`Ratelimit.limit()` is one round trip whose sliding-window Lua script runs `GET`, `GET`,
`INCRBY` and (on a new window) `PEXPIRE`. `checkRateLimit` used to run a per-minute *and*
a per-day limiter on every tier, so every request paid twice over.

`strict` keeps its daily quota because it fronts search, which fans out to a dozen partner
sites, and because its 500/day is a documented promise to anonymous v1 callers in
`docs/openapi.yaml`. `standard`, `lenient` and `account` had 1000/5000/2000-a-day quotas
no real person had ever approached; their per-minute windows (30/120/60) still bound the
damage. A new daily quota has to earn its round trip.

### Why the search fan-out shares one read

The fan-out reads one cache key per platform for the same query. `cachePrefetch` does them
in a single `MGET` and hands the result to each fetcher via `cacheGetOrFetch`'s
`prefetched` argument. The fetchers still own their own TTLs, `shouldCache` predicates and
write-backs — only the read is shared. Add a new cached platform to that key list in
`searchAllPlatforms` rather than letting it issue its own `GET`.

### The two traps

**Don't cache a constant.** `searchAmpwall` is still a stub with no outbound request, and
it used to run its empty result through Redis — a `GET` per search, plus a `SET` per miss,
to remember a compile-time constant. Cache a value when there is a real fetch to protect.

**A warm container is free; Redis is not.** `getMergeOverrides` / `getLinkSuppressions` are
read on every search and again during Phase 2 enrichment, and they are identical for every
visitor. They now sit behind a 60-second in-process memo in `db.ts` as well as the Redis
cache. Sixty seconds is deliberately short so `invalidateAdminListCache` keeps its meaning:
an admin edit still lands everywhere within a minute. This is the exception, not a pattern
to spread — those two lists are the only values that are global, tiny, and read on every
search.

`checkSentryDedup` was `GET` then `SET`; it is now a single `SET ... NX EX`, which is half
the cost and atomic besides.

`.github/workflows/upstash-keepalive.yml` is unrelated to any of this — it writes one key
twice a week so the free-tier database isn't reaped for inactivity, which silently killed
caching and rate limiting once. It costs 8 commands a month.

---

## Why search is no longer a cataloguing trigger

**Rule it produced:** demand-driven triggers only, plus the twice-daily sweep. Search
doesn't queue crawls.

`persistSearchResults` used to hand every Bandcamp-linked artist in a result set to the
crawler. That made an unauthenticated, traffic-driven path the site's largest producer of
database writes: 60 first-time crawls an hour, against the sweep's 100 a *day*. Each one
inserted rows into three six-index tables and then re-read them monthly forever.

That exhausted the Supabase disk I/O budget for the third time, after two rounds of
per-operation fixes (#443, #463, #464) that never touched the volume. Full reasoning,
the confirming SQL, and the escalation ladder if the warning returns:
`docs/specs/supabase-disk-io-investigation.md`.

Until 2026-09-13 a searched artist was still reached, because the sweep's pool was every
artist with a catalogue-able link. It no longer is — see the next section.

The whole feature's off-switch remains the `RELEASE_CATALOG_ENABLED` env var: deleting it
in Netlify stops cataloging with no deploy.

### Why the sweep builds only for saved, claimed and collected artists

**Rule it produced:** a first catalogue needs demand — a save, a verified claim, or a record
in a connected collection. Already-catalogued artists keep refreshing whoever they are.

The pool went the other way first. Saved-only is how the sweep shipped; measured 2026-08-02,
there were 2,564 artists with a catalogue-able link against 9 saved by anybody, so the
sweep's whole universe fit in one batch and it sat idle almost every run, and `/a/:slug`
renders a release list for any catalogued artist. So the pool became everyone with a link.

That made the pool a function of search traffic. `persistSearchResults` stores a link row
for every artist a search resolves, and the sweep's own logs showed the consequence: 2,564
artists on 2026-08-02, 4,456 on 2026-09-12 — about 46 new a day against a sweep of 50 — and
21–23 of every 25 picked never attempted before. A first-time catalogue is the expensive
case (seven indexes on `releases` per row, sources, offers, up to 40 detail pages) and the
diffing from disk I/O round 4 cannot make it cheaper, so halving the cadence halved the
writes and the Supabase warning came back within a week. Search still decided what got
catalogued, one step removed from the trigger removed above.

The product judgement, from the owner: most searches are for large artists whose
discography is a click away on Bandcamp or Qobuz, and the release pages earn their keep for
small, claimed artists promoting their own work as an alternative to Linktree or Odesli. So
a first crawl now needs one of three signals, and the searched-but-unwanted tail is counted
in the sweep log as `awaitingDemand` rather than crawled. Existing catalogues are not frozen,
because a page showing a stale price is a transparency problem; if the I/O graph still
doesn't settle, stopping the refresh of non-demand artists is the next dial.

Collections are in the list because the import asks for only the first 25 artists of a sync
directly and relies on the sweep for the rest — dropping them would have silently broken the
gap report. The arithmetic and the advisor findings that turned out to be irrelevant are in
`docs/specs/supabase-disk-io-investigation.md`, Round 5.

### Why the pool and `catalogArtist` must agree

An artist with only an official site is recorded as a *failure* by `catalogArtist`, so
sweeping them poisons `consecutive_failures`. `CATALOGUEABLE_PLATFORMS` in `db.ts` and
`catalogArtist`'s "no bandcamp, discogs, faircamp, jam.coop, or mirlo link stored" check
therefore have to change together. Mirlo was added to both in the same PR (#415) for
exactly that reason.

### Why the sweep reports rather than 202s

`getStaleCatalogCandidates` drops artists inside the 7-day re-catalogue cooldown up front,
reading the same `RECATALOG_COOLDOWN_HOURS` constant, so a bounded batch isn't spent on
artists that would be refused a moment later. But `claimArtistForCatalog` — that cooldown
plus the per-trigger hourly cap — stays the authority, which is why running the sweep twice
is a no-op.

It returns a real summary rather than 202, and any refusal is a non-2xx that fails the
workflow. A scheduled job that reports success while doing nothing is the same silent
failure the sweep was built to fix.

Cadence is 25 artists per run, every twelve hours — 50 a day, halved from 100 in disk I/O
round 4. The workflow comment says when to put it back.

---

## PostgREST's silent 1,000-row cap

**Rule it produced:** page every read whose table can exceed 1,000 rows (`readAllPages`, or
`.range()` in a loop).

PostgREST caps every response at 1,000 rows whatever limit you ask for, and truncates
*silently*. A single `.select()` over `artist_links` returns 1,000 of ~3,900 rows and looks
completely successful — which would hide three quarters of the sweep's pool.

---

## Release dedup: the measurements behind the three tiers

**Rules they produced:** under-merge, never over-merge · release type is not identity ·
dates are the separator · a release may hold several sources per platform.

### Why release type was removed from identity

Discogs' artist listing carries no type field for a master, so 92% of Discogs rows are
typed `other` while the same record arrives from Bandcamp as `album`. Keying identity on
`(release_type, match_key)` meant those two could never meet.

Measured 2026-08-29: 1,181 pairs of byte-identical titles under one artist sat on artist
pages twice — unmerged *and* unflagged, because flagging was type-scoped too.

Where the types genuinely differ and both are meaningful, the data still says one record.
`Live At The Echo` filed 'live' by one source and 'album' by the other, same day, is one
album. Putting type back into identity would be a regression.

### Why `date_precision` is stored, and why a missing date is not disagreement

`releaseDatesDisagree` compares only as far as the *coarser* of the two precisions vouches
for. Discogs' bare year arrives as `2020-01-01` and means "sometime in 2020", so comparing
it to a Bandcamp day as a full date would call every such pair different.

A missing date is never disagreement. The question the function answers is "do we have
evidence these are two records", and silence is no evidence.

### Why the date veto is what makes the review queue usable

Of 858 fuzzy pairs in the catalog, 687 are pairs whose day-precision dates differ, and
every one sampled was a false positive — "Acid Dub Versions III" against "II", four volumes
of "As I Hear Them In My Head".

A queue that is 80% noise trains its reviewer to dismiss without reading, which is worse
than no queue.

### Why uniqueness changed to allow several sources per platform

Since `20260829120000_release-sources-multi-per-platform.sql`, uniqueness is
`(release_id, platform, COALESCE(external_id, ''))`.

Discogs files two masters for one record often enough that 59 duplicate pairs had a Discogs
source on both sides, and the old `UNIQUE (release_id, platform)` made every one of them
unmergeable. At most one source per platform may lack an id, because two id-less rows on
one platform can never be told apart. The global `UNIQUE (platform, external_id)` is
untouched and still keeps re-crawls idempotent.

Two consequences that are easy to reintroduce as bugs:

- Anything rendering a "where to buy" list must go through `oneSourcePerPlatform`
  (`api/shared/release-display.ts`, importable from both Node and Deno) or
  `orderedSourcePlatforms`, which dedupes. "Discogs · Discogs" reads as a bug and prints
  one platform's payout twice.
- `persistDiscogsReleases` looks up a master id in `release_sources` as well as in
  `releases.discogs_master_id`. The release column holds exactly one, and a merge keeps the
  survivor's — so without that second lookup the next catalogue pass wouldn't recognise the
  merged-away master and would re-create it. That is how a review queue refills itself
  forever.

### Changing a rule only changes tomorrow

Ingest compares a release it is *writing* against what is stored, so nothing already in the
catalog is revisited. `npm run dedupe:releases` applies the current rules to what's already
there — report-only by default, `--write` to apply — and it merges through `mergeReleases`
rather than a copy of it.

---

## Collections: why there is no source URL to fall back to

**Rule it produced:** never derive a Bandcamp album URL; match on `match_key` via
`releaseMatchKey` or leave the item unlinked.

Bandcamp's Subsonic API returns `id`, `name`, `artist`, `coverArt`, `year`, `genre` and
`created` — and nothing else. No album URL, no artist URL. So "just link to Bandcamp" is
not available, and deriving `<artist>.bandcamp.com/album/<title>` mints 404s.

Most of a real collection arrives unlinked because the fan bought from artists nobody has
ever searched, so there is no `artists` row to match against.

### Why discovery runs on the failure path too

`resolveCollectionArtists(userId)` runs at the end of a sync on **both** the success and
the failure path, and after the connection row is written either way. It reads stored
`collection_items` and probes `<slug>.bandcamp.com/music`, touching neither the Subsonic
API nor the credential — so a Subsonic 500 (routine in this beta) must not block discovery
for items imported days earlier.

It requests catalogues for up to 25 artists, matching `MAX_ARTISTS_PER_REQUEST`, which
silently slices anything longer. The rest ride the twice-daily sweep.

`linkCollectionItemsForArtist(artistId, name)` runs at the end of every catalogue pass in
`catalog-artist-background.ts` — the moment the releases exist — and attaches them to the
items that were waiting. It re-runs forever, so a release added later still finds fans who
own it.

### Why `normalizeForComparison` is the wrong function here

It strips to `[a-z0-9]`, so any title with no Latin characters normalizes to the empty
string and can never match. Use `releaseMatchKey`, the function that produced the
`releases.match_key` column.

A near-miss stays unlinked on purpose: a collection page asserts that a specific person
bought a specific record.

---

## Why release cataloguing can't be tested on a preview or locally

**Rule it produced:** use `npm run ingest:try`; never set `RELEASE_CATALOG_ENABLED`
locally.

Deploy previews and local runs both point at **production** Supabase, so an ungated preview
would write real `releases` rows and spend the real hourly crawl budget. Setting the flag
locally would have your laptop writing production data.

### The `CONTEXT` trap

This used to gate on `CONTEXT === 'production'`, which silently disabled cataloging
entirely. Netlify exposes only `URL`, `SITE_NAME` and `SITE_ID` to a serverless function at
runtime, so `process.env.CONTEXT` is `undefined` in every deployed function. Don't reach
for `CONTEXT` or `DEPLOY_PRIME_URL` in a function — neither exists there.

### Why there is deliberately no `--write` flag

Everything with a decision in it lives upstream of the database, and `persistReleases` is
covered by unit tests plus a migration validated against a real Postgres. To test the write
path, point `SUPABASE_URL` at a branch database on purpose.

### What the preview harnesses do and don't cover

`npm run dev` renders `/a/{artist}/{release}` through the real `api/edge/release-page.ts`,
and behaviour matches production exactly — verified 2026-08-15: an uncatalogued release
302s to the artist page locally and in production alike. `npm run dev:fast` cannot, because
bare Vite runs no edge functions at all.

The remaining gap is data, not rendering. `netlify dev` reads production Supabase, where a
release only exists once demand-driven cataloging has run for that artist. `npm run
preview:release` closes that gap: it fetches the real `/music` grid, lists the discography,
and renders any release through the **real** edge function — same template, same payout
maths — fetching that release's page from Bandcamp on demand. Only the two database reads
are stubbed; there is no database connection, so nothing can be written. One Bandcamp
request per release page you open.

### The observability surface

`release_catalog_state` holds `last_attempted_at`, `releases_found`, `last_error`,
`consecutive_failures`, `last_trigger`. A run that suddenly finds 0 releases where it
previously found 20 is a parser break or a bot challenge, not an artist deleting their
catalog — `recordCatalogOutcome` reports exactly that transition to Sentry, since it is
otherwise recorded as a perfectly ordinary success.

---

## Local dev: what the two silent-failure traps cost

**Rules they produced:** delete a key from `.env` rather than leaving it blank; keep
`--strictPort`.

### The empty-value shadow

A key present but blank in the local `.env` overrides the real value from the Netlify site
settings. `netlify dev` reports it as `Ignored project settings env var: X (defined in .env
file)`.

Three keys were blank this way until 2026-08-15 — `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY` — which is why local auth never worked and
every signed-in endpoint failed. Check the startup log's `Injected project settings env
vars` list: a key you need should appear there, not in an `Ignored` line.

### The stale port

`dev:fast` passes `--strictPort` on purpose. See the `[dev]` block in `netlify.toml` for
why removing it lets another checkout's leftover server answer everything.

### Why there is no preview to fall back on

#451 disabled Deploy Previews outright (`[context.deploy-preview] ignore = "exit 0"` in
`netlify.toml`), because they were ~280 of a 300-minute monthly allowance — the largest
single cost on the site. Production deploys at the same cadence fit.

That block's own comment says previews should come back "once local dev can stand in for
them". Until then, `npm run dev` is the only way to exercise the real backend before
merging, so treat a gap in it as a real gap rather than an inconvenience.

### `deno.lock` drift

Running `npm run dev` rewrites `deno.lock`, because it re-resolves the edge functions'
imports against the current `package.json`. That shows up as an unrelated modified file:
`git checkout -- deno.lock` before committing, same habit as the generated feed XML.

The drift it keeps re-applying is real, though — the committed lock predates `@sentry/node`
and `@testing-library/*` being added, so it is worth refreshing deliberately in its own PR.

### Why the `apps/web/server/` shim is not the backend

`apps/web/vite.config.ts` installs `handleApiRequest` from `apps/web/server/api.ts`, with
its own search implementation in `apps/web/server/search/*`. It has drifted from
`api/functions/` and only `dev:fast` uses it.

Editing `api/functions/search-sources.ts` does not change what `dev:fast` returns, and
editing `apps/web/server/*` does not change production. Concretely: the shim's
`/api/suggest` returns a hardcoded empty list, where `npm run dev` returns real rows from
the `artists` table.

---

## The migration that blocked `main` for 30 hours

**Rule it produced:** if you apply a migration ahead of its merge, merge it promptly — and
check the workflow went green.

`supabase db push` refuses to run when production has an applied version that isn't in
`supabase/migrations/` locally, and it aborts *before applying anything*. So one migration
applied from a branch that then sits unmerged blocks everybody's migrations on `main`,
silently.

This happened. `20260809120000_bandcamp-collection.sql` went to production on 2026-08-09
from the still-open PR #438, and three consecutive runs on `main` then failed without
applying anything. One stranded migration added `releases.alert_sent_at`, which
`api/functions/notifications.ts` had already shipped code against — so release alerts were
down for about 30 hours. The fix was to add the missing file to `main` so the repo again
recorded what production has.

Running the workflow by hand (`workflow_dispatch`) from a feature branch is sometimes
necessary, since deploy previews share the production database and an additive migration
has to land early for the preview to exercise it. The failure mode is loud in Actions and
invisible everywhere else.

### Why `--project-ref` is not an option any more

`migrate:dry-run` and `migrate:list` use `--linked`, matching the workflow. The CLI dropped
`--project-ref` from these commands, and passing it makes them print a help blob and exit
*without* checking anything — which reads like a clean run. If you see `Cannot find project
ref`, run `npm run migrate:link`. `supabase link` writes only to the gitignored
`supabase/.temp/`.

The dry run needs credentials, so it can't substitute for validating a migration's SQL. For
that, run it against a throwaway Postgres in Docker — that's what caught the scoping on
`20260803000000_clear-bandcamp-placeholder-404-backoff.sql`.

---

## Why the test suites left the build

**Rules they produced:** `npm run verify` is the gate; a red CI run does not stop a deploy.

The suites run in GitHub Actions (`.github/workflows/ci.yml`) on every PR and every push to
`main`, because Actions minutes are free on this public repo while a Netlify deploy is not.

Netlify builds whatever lands on `main` regardless of CI. Requiring the `verify` check in
GitHub's branch protection rules for `main` is what would restore the old guarantee; until
that's enabled, merging a red PR deploys it.

`npm run lint` is not in the gate because ESLint reports 64 pre-existing errors (unused
vars and `any` in test files, plus a few pages), so enforcing it would fail every PR for
reasons unrelated to the change. Worth clearing separately; until then, lint is advisory.

---

## Why not every push deploys

**Rule it produced:** `scripts/netlify-ignore-build.sh` exits 0 to cancel, 1 to build, and
every branch defaults to deploying.

A production deploy costs a flat 15 credits on Netlify's credit plans (build minutes on the
legacy plans), and an Apple-app bugfix used to buy a full deploy of the website. So the
script cancels the build when a push touches only paths Netlify never publishes:
`apps/mac/`, `apps/extension/`, `supabase/`, `docs/`, `.github/`, `README.md`, `CLAUDE.md`.

Every branch in it defaults to deploying, because a skipped deploy leaves production
silently stale — the worse of the two failures.

`data/` and `scripts/` are deliberately absent from that list: the whole `data/` tree is
copied into `dist/`, and `scripts/` generates the manifests, feeds and sitemap. If you add
a path whose contents reach the built site, check it isn't shadowed.

---

## Bandcamp discovery: why the search endpoint can't be used

**Rule it produced:** derive candidate slugs and probe `<slug>.bandcamp.com/music`; verify
both identity and substance.

`bandcamp.com/search` is behind a Fastly bot challenge and `Disallow`ed in Bandcamp's
robots.txt. `<slug>.bandcamp.com/music` is robots-permitted, and one request per candidate
resolves identity (`data-band`), release counts, location, release titles, and the artist
photo.

Both verification steps are load-bearing: a slug existing doesn't mean it's the right
artist, and a name matching doesn't mean it's a real presence — parked, empty accounts match
`beyonce`, `sufjan`, `jackwhite`.

Negatives are cached too, otherwise every search for an artist who simply isn't on Bandcamp
re-probes forever.

The `probed_slugs` column exists because `query_norm` strips punctuation, but punctuation is
what generates extra slug candidates — so recording which slugs were actually tried is what
stops a cached negative from hiding an artist whose name has a hyphen.

Full research: `docs/specs/bandcamp-coverage-research.md`.

---

## The dead Vercel-era files in `api/search/`

**Rule it produced:** only `bandcamp-probe.ts` and `enrichment.ts` in that directory are
live.

`api/search/sources.ts`, `bandcamp.ts`, `site-search.ts` and `musicbrainz.ts` import
`@vercel/node`, which isn't even a dependency, and are imported by nothing. Editing them is
a classic wasted-session trap: the change deploys and nothing happens. Verified in
`docs/specs/bandcamp-coverage-research.md` §1.

---

## The Dispatch: what changed on 2026-04-17

The Dispatch is a weekly music-industry briefing. It is now delivered to the
`#unstream-dispatch` Discord channel by a scheduled agent, and RSS publishing was retired.
Nothing new is written to `data/dispatch/`.

What remains in the repo is the archive: `data/dispatch/2026-W16.md` and earlier, plus
`scripts/generate-dispatch-feed.ts`, which still runs at build time so `/dispatch.xml`
keeps rendering the historical feed. See `data/dispatch/README.md` for the full history.

The old "commit dispatch work directly to `main`" instruction is dead — do not follow it.
Dispatch-related repo changes go through the normal branch workflow like everything else.
