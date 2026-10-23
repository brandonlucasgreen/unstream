# Infrastructure independence: Netlify → Cloudflare, GitHub → Codeberg

**Date:** 2026-10-18
**Status:** Decided (Brandon, 2026-10-18). Phases 1a, 1b, 1c and 1d built and verified locally,
not cut over (see "Where Phase 1 stands"). 1b was promoted from follow-up to prerequisite on
2026-10-19 and built the same day. **Cutover PAUSED (2026-10-23): Bandcamp challenges every page
request from a Cloudflare Worker**, so Bandcamp discovery, card data and the catalogue would stop.
Don't take checklist step 10 or later until `bandcamp-from-workers.md` is resolved. Staging
(next.unstream.stream) stays up for testing everything else.
**Scope:** everything around the database. Supabase stays for data and sign-in; the database is
a later decision (see "Later").

## Why

Unstream should run, as far as practical, on providers that are **not venture-funded and not a
hyperscaler (AWS, Google, Microsoft)**, and whose values Brandon can stand behind, without turning
a small project into a migration project. Today:

| Layer | Today | Owner / runs on | In this plan |
|---|---|---|---|
| Functions, edge, CDN, deploys | Netlify (legacy free plan) | VC-backed; Functions run on AWS Lambda | → Cloudflare Workers |
| Cache, rate limits, flags | Upstash Redis (free) | VC-backed, AWS/GCP | → Cloudflare KV, Durable Objects, rate limiting |
| Transactional email | Resend (free) | VC-backed | → Cloudflare Email Service, once it's out of beta |
| Code, CI, scheduled jobs | GitHub + Actions | Microsoft | → Codeberg, CI on Brandon's Mac Studio |
| Issues | Linear | VC-backed | → Forgejo issues on Codeberg |
| Error tracking | Sentry | VC-backed | Stays; GlitchTip optional |
| Database + Auth | Supabase (free Nano) | VC-backed, AWS | **Stays for now** |
| License | none (all rights reserved) | — | MIT (#648) |

**Why Cloudflare** (Brandon, 2026-10-18): already in the stack (DNS, CDN, R2 backups), a public
company that isn't VC-backed and runs its own network, with values Brandon trusts. Moving the
app there *reduces* the number of providers instead of adding one.

**Why the database waits:** leaving Supabase is the expensive part of any move: 373 query call
sites in 43 files, 20 Postgres functions, RLS policies, and sign-in across the web app, the Mac
app and the extension. It's a large project for a small product, and the remaining options each
have real costs (see "Later"). Supabase on AWS is the accepted compromise for now.

## Where it ends up

| Layer | Target | Notes |
|---|---|---|
| App | **Cloudflare Workers** (Workers Paid, $5/month) with static assets | API, server-rendered pages, background jobs, the SPA |
| Background jobs | Cloudflare Queues, Cron Triggers, `waitUntil` | Replaces Netlify background functions and two GitHub Actions schedules |
| Cache, rate limits, flags | Cloudflare KV, Durable Objects, the rate-limiting binding | Upstash gone |
| CDN + DNS | Cloudflare (as now) | Cache by tag, purge by tag |
| Database + Auth | Supabase (free; Pro when outages justify it) | Unchanged |
| Email | Resend until Cloudflare Email Service is generally available | Not urgent |
| Code, issues | Codeberg (Forgejo) | MIT-licensed since #648, which Codeberg requires |
| CI | A Forgejo runner on Brandon's Mac Studio | Alerting when it goes quiet (Phase 0) |
| Error tracking | Sentry (its Cloudflare SDK); GlitchTip optional | Same project and alerts |
| Stays as is | Stripe, GoatCounter, Buttondown, Cloudflare R2 (backups, social cards) | |

### Why Workers Paid ($5/month), not the free plan

The free plan's per-request limits don't fit a search:
- **10 ms of CPU per request.** Network waits don't count, but parsing a dozen platforms' HTML,
  matching and merging does. A Worker over its limit fails the request with an error page.
- **50 outbound requests per request.** A search's fan-out (~17 platforms, Bandcamp probe
  candidates, Supabase reads) can reach it.
- **KV allows 1,000 writes a day.** Upstash's caches would pass that at around 100 searches a day.

Workers Paid includes 10M requests and 30M CPU-ms a month, 30 s of CPU per request (up to 5 min),
far higher outbound limits, 1M KV writes and 1M Queue operations a month.

**Re-checked 2026-10-18** against Cloudflare's own limits page, and all of it still holds:

| | Free | Paid |
|---|---|---|
| CPU per invocation | 10 ms | 30 s default, 5 min maximum (`limits.cpu_ms`) |
| Subrequests per request | 50 | 10,000, raisable to 10M (`limits.subrequests`) |
| Memory per isolate | 128 MB | 128 MB |
| Script size, uncompressed | 64 MiB | 64 MiB |
| Environment variables | 64 | 128 |
| Cron Triggers per account | 5 | 250 |
| Queue consumer wall clock | — | 15 min per invocation |

Two numbers to size against, both comfortable: the Worker bundles to **3.2 MB (666 KB gzipped)**
against the 64 MiB limit, and the site reads **34 environment variables** against the 128 allowed.
Simultaneous outgoing connections are 6 on both plans — the search fan-out already queues behind
that on Netlify, so it is not a change, but it is the limit worth watching if the fan-out grows.

### What was considered and ruled out (2026-10-18)

- **Everything on DigitalOcean** (App Platform for the app, Managed Postgres, PostgREST and GoTrue
  in containers): drafted in full earlier in this PR's history (#647) and dropped:
  - it moves the database and sign-in, a huge transition for a small project;
  - DigitalOcean is an ecosystem Brandon doesn't know;
  - it publishes no values Brandon could point to.

  `digitalocean-database-plan.md` stays as the fully planned option if the database ever moves
  to managed Postgres.
- **Cloudflare Workers with a DigitalOcean database:** two compute platforms (PostgREST and GoTrue
  would still need containers), for no gain over keeping Supabase.
- **Supabase Pro:** not ruled out, only deferred. It's the fix for the outages (see "Later").
- **Self-managed VPS (Hetzner, Coolify):** the database's durability would be Brandon's.
- **Bunnyshell, Bunny.net, Render, Railway, Fly, Koyeb, Neon, Aiven, Ubicloud:** VC-backed or
  acquired. **EthicalHost.ca and similar:** shared hosting, no Node or managed Postgres.

## Cost

| | Monthly |
|---|---|
| Cloudflare Workers Paid (Queues, KV, Durable Objects within its allowances) | $5 |
| Cloudflare R2 (backups, social cards) | $0 within the free tier |
| Supabase | $0 free; $25 on Pro |
| Upstash | $0, then gone (Phase 2) |
| Email, Codeberg, the Mac Studio runner | $0 |
| **Total** | **$5, or ~$30 with Supabase Pro** |

## Keep it portable

Brandon may one day offer a **self-hosted Unstream**, and Cloudflare's Queues, KV and Durable
Objects are Cloudflare-only. So every Cloudflare-specific call stays behind the modules that
already wrap infrastructure: `cache.ts`, `ratelimit.ts`, `feature-flags.ts`, `request-catalog.ts`
and `purge-cache.ts`. Handlers never touch a binding directly. A self-hosted build then means
writing those modules for Node plus Redis or Postgres, not touching every handler. The Worker
runtime itself (`workerd`) is open source.

## The phases, in order

Each phase ships on its own, leaves the site working, and has a rollback.

### Phase 0: no-cost groundwork (any time)

| # | Step | Who |
|---|---|---|
| 0.1 | Record the decision: this doc, CLAUDE.md's pointer | Done (this doc) |
| 0.2 | MIT `LICENSE`: the Press page said "open source", but with no license file the code was legally all rights reserved; Codeberg also requires one | Done (#648) |
| 0.3 | **Social cards leave the app** (#649). The weekly generator draws the Instagram cards when it schedules and uploads them to R2. The heaviest function (~130 ms of CPU, fonts and wasm) is gone before Phase 1, which matters for Workers' CPU budget. The old endpoint stays two weeks for already-scheduled posts, then a follow-up removes it | In progress; Brandon sets up the R2 bucket |
| 0.4 | **Alert when the Mac Studio goes quiet.** The code review agent already runs there (and CI will, Phase 4), so if the Mac is down, PRs merge unreviewed and nothing says so. A launchd job pings Healthchecks.io every few minutes, and the review agent pings after each review; Healthchecks sends a missed ping to **hosted** ntfy.sh (an unguessable topic name, since ntfy.sh topics are readable by anyone who knows the name) and to email. The ntfy server on the Mac can't do this: it goes down with the thing it's watching | Brandon, ~15 min |
| 0.5 | Measure email volume, for Phase 3: `select date_trunc('day', created_at) d, count(*) from email_log group by 1 order by 1 desc limit 30;`. Note whether Supabase's auth emails use its built-in sender or Resend's SMTP (Supabase → Authentication → SMTP) | Brandon |

### Phase 1: the app, Netlify → Cloudflare Workers ($5/month; Netlify goes to $0)

**Lift and shift first, simplify second:** the first cutover changes where the code runs and
nothing else. Supabase, Upstash and every environment variable stay as they are.

**1a. One Worker that runs the existing code**
- **Function adapter:** turns each `Request` into the Lambda-style `event` the 67 handlers already
  take, and their `{ statusCode, headers, body }` back into a `Response`. Handlers stay untouched.
- **Routes:** generated from `netlify.toml`'s 72 redirects, so `/api/*` and the feed URLs keep
  their paths. A test asserts every `[[redirects]]` entry has a route.
- **Headers:** the 3 `[[headers]]` blocks (including CSP) are applied with the same values.
- **The 7 edge functions** are already Web-standard code, the closest fit. `Deno.env.get` becomes
  the Worker's env, `esm.sh` imports become npm packages, and `context.next()` becomes "serve the
  SPA". The crawler/browser split in `artist-page-static` and `u-handle` keeps its
  one-route-one-renderer shape: decide per request, before any query.
- **Static assets:** `apps/web/dist` served by Workers static assets, with the SPA fallback.
  Static asset requests are free and don't count against the Worker.
- **Node compatibility:** `nodejs_compat` for `supabase-js`, `jose` and the parsers. Check each
  dependency runs in Workers before porting anything else.
- **`safeFetch`** resolves DNS itself to require public IPs. Check what Workers' `node:dns`
  supports. Workers can't reach private networks or cloud metadata endpoints anyway, but keep the
  hostname allowlist and the per-hop redirect re-validation either way.
- **Smart Placement,** so the Worker runs near Supabase rather than near each visitor. Every
  search makes several sequential database reads.
- **Sentry:** `@sentry/cloudflare` instead of `@sentry/node`, same DSN; `withSentry`'s flush
  becomes `waitUntil`. The web client's Sentry is unchanged.
- **Secrets** move from Netlify's environment to Worker secrets.

**1b. Background jobs and schedules — required before the cutover, not after.** See "Phase 1b is
a prerequisite for the cutover" below for the two blockers that moved it.
- **Search persistence:** `ctx.waitUntil()` after the response (done in 1a). `request-persist.ts`
  and the persist background function go away. Safe on `waitUntil`: a handful of upserts, well
  inside its 30-second ceiling.
- **Catalogue crawls and the Bandcamp collection sync** become Queue consumers:
  - Queues gives retries, a dead-letter queue, concurrency as a setting (the crawl pacing budget)
    and a visible backlog. "Is cataloguing running?" becomes a glance; it would have caught the
    six days nothing was catalogued.
  - The internal HTTP handshakes, `internal-origin.ts` and the function-to-function
    `INTERNAL_FUNCTION_SECRET` checks for these jobs go away.
  - **Checked, 2026-10-19:** a queue consumer gets 15 minutes of wall clock, against a crawl
    budgeted for 9 minutes of detail fetching and a 13-minute enrichment cutoff. It fits, but not
    by much — so keep `DETAIL_BUDGET_MS` and `ENRICHMENT_CUTOFF_MS` under the 15, and split work
    per page if either ever grows.
  - `ctx.waitUntil` is **not** an option for these: it allows 30 seconds, and a crawl killed
    there still counts as an attempt, so the artist is skipped until the cooldown lapses.
- **Schedules:** the catalogue sweep and the tips-review notifier become Cron Triggers, and
  `recatalog-sweep.yml` and `tips-review-notify.yml` go away. **This is the blocking part**: both
  workflows name `unstream.netlify.app` on purpose (Bot Fight Mode challenges the runner on the
  `unstream.stream` zone), so after the cutover they would drive the idle Netlify site and then
  fail silently when it is retired. A Cron Trigger has no HTTP hop to be challenged, which also
  retires `INTERNAL_FUNCTION_SECRET` and `api/lib/internal-origin.ts`.

**1c. Caching on Cloudflare's own CDN**
- `Netlify-CDN-Cache-Control` becomes the Cache API or `CDN-Cache-Control`. Release pages (#638)
  and the cached API responses keep their TTLs.
- The crawler-split pages (`/a/<slug>`, `/artist/*`, `/u/*`, `/tip/*`) stay uncached: the cache
  key is the URL, the same reason they aren't cached on Netlify.
- `purge-cache.ts`: Netlify's purge API becomes Cloudflare's purge-by-tag (5 requests a minute on
  the free zone plan). `Cache-Tag` keeps its name.

**1d. Local dev and previews**
- `wrangler dev` replaces `netlify dev`, which removes the `netlify dev` traps from CLAUDE.md.
  Like now, it runs against production Supabase.
- Every uploaded version gets a preview URL, so **per-PR previews come back without spending a
  build allowance**. **Upload them to the staging Worker (`wrangler versions upload --env
  staging`), never the production one.** A version of the production Worker carries its
  `URL=https://unstream.stream` and its live Stripe key, so `isProductionSite()` would call a PR's
  unreviewed code production and let it take real payments — the same gap Netlify deploy previews
  have. Staging's `URL` and test key keep a preview harmless.

**1e. Cutover**

- **Stand up `next.unstream.stream`** — a custom hostname on the zone we already own, not the
  free `*.workers.dev` address. Unstream has never had a staging environment; this is one, and it
  costs nothing beyond the Worker already being paid for. The hostname matters: Cloudflare
  documents the Cache API as functional on *custom domains*, and purge-by-tag is zone-scoped, so
  `workers.dev` cannot verify either of the two things most worth verifying.
- It reads and writes **production Supabase**, exactly as `npm run dev` does, so a test save,
  claim or username is a real one. It needs its own copy of the secrets.
- Walk through:
  - search, artist and release pages, and the edge-rendered pages as a crawler (curl with a
    Googlebot user agent);
  - sign-in, saves, and tips in test mode;
  - feeds, `/appcast.xml` and the Queue-driven catalogue crawl;
  - **that purge-by-tag actually evicts a Cache API entry** — load a release page twice to get a
    `cf-cache-status: HIT`, edit that artist, then confirm the page re-renders instead of serving
    the old copy for the rest of the hour. This is the one thing no local run can prove, and the
    docs support each half of the claim in a different place without ever joining them.
- **Cutover:** route `unstream.stream` to the Worker.
- **Rollback:** route it back to Netlify. Keep the Netlify site, idle, for two weeks.

**1f. Recommended: own the auth URL.** Not needed while Supabase stays, but it is the
prerequisite for the later database route (see "Later"). Point the clients' auth at an
`unstream.stream/auth/v1/*` proxy instead of the hard-coded `supabase.co` address
(`AuthService.swift`, `lib/supabase.js`), in the next Mac and extension releases. A later
database move (or a self-hosted build) then needs no client release.

### Where Phase 1 stands (2026-10-18)

**Built and verified locally: 1a, 1b, 1c and 1d.** The Worker runs the whole site — 66 handlers, 7
server-rendered pages, the SPA — and `npm run verify` is green (2,191 API and Worker tests, 1,340
web tests, a clean typecheck of every handler the Worker imports). It bundles to 666 KB gzipped
and was walked through end to end under `wrangler dev`: API routes, the retired-guides redirects,
the feeds, the noscript search render, the crawler/browser split, a missing build asset 404ing
rather than returning the SPA, and POST bodies reaching handlers intact.

**Not cut over.** Production is still Netlify, and nothing here changes that; see "What Brandon
has to do" below.

### Phase 1b: done, and it was a prerequisite (2026-10-19)

1b was filed as the next nice thing: Queues for retries, a dead-letter queue, a visible backlog.
Checking the numbers turned up two blockers instead, which is why it moved ahead of the cutover
and was built immediately. **Neither affected production** — nothing is cut over — but both would
have bitten on the day it was, and both were silent.

**1. `ctx.waitUntil` gives 30 seconds. A catalogue crawl needs 9 to 13 minutes.**

Cloudflare allows background work to continue for **30 seconds** after the response, shared
across every `waitUntil` call in that request, and cancels whatever hasn't settled. A catalogue
run is built around `DETAIL_BUDGET_MS = 9 minutes`, an `ENRICHMENT_CUTOFF_MS` of 13, and ~215
seconds of measured fixed overhead (`catalog-artist-background.ts`). So a crawl moved onto
`waitUntil` is killed roughly twenty times short of finishing.

It is worse than a truncated crawl. `claimArtistForCatalog` writes `last_attempted_at` and
returns *before* the crawl starts, so an artist killed at 30 seconds is recorded as attempted and
is not retried until the cooldown expires. The symptom is a catalogue that looks healthy and
quietly stops filling — the exact shape of "The six days nothing was catalogued".

Queue consumers get **15 minutes**, which is why the crawls belong there. **Done:** the
dispatcher now enqueues (`BACKGROUND_QUEUE`, one message per crawl, `max_concurrency: 1` so the
existing pacing delays still mean what they say), and a consumer runs it with retries and a
dead-letter queue behind it. The dispatcher is also `async` now and its answer means something —
it used to return `true` the moment work reached `waitUntil`, so a caller recorded acceptance for
work that could still be cancelled.

*(The other two `waitUntil` users are fine: search persistence is a handful of upserts. The
Bandcamp collection sync is the one to measure before trusting it — a large collection may not
fit in 30 seconds either.)*

**2. The scheduled jobs point at Netlify by name.**

`recatalog-sweep.yml` and `tips-review-notify.yml` POST to the Netlify site by name
(`unstream.netlify.app/.netlify/functions/<name>`) — deliberately, because Bot Fight Mode on the
`unstream.stream` zone challenged
the runner's curl and cost six days of cataloguing in October 2026. After the cutover those calls
keep reaching the *idle Netlify site*, running the old code; once Netlify is retired two weeks
later, they fail outright, and a job that never starts never reports a failure.

Repointing them at Cloudflare walks straight back into Bot Fight Mode, so that is not the fix.
**Cron Triggers are**, because they remove the HTTP hop altogether. **Done:** both schedules are
`triggers.crons` in wrangler.jsonc on their original cadences, and the two workflow files now
carry a header saying they must be deleted at cutover — crons only fire on a deployed Worker, so
until DNS moves the workflows are still what runs, and leaving them afterwards means the job runs
twice against one Supabase.

**And one thing the plan had not accounted for: staging would have run them.** A Cron Trigger
fires on any deployed Worker that declares one, and 1e stands up `next.unstream.stream` against
the *same production Supabase*. A sweep there writes real catalogue rows; the tips notifier sends
real notifications. So the staging environment declares `crons: []` and its own queue —
structural, not a runtime check — and `scheduled()` additionally refuses unless
`SCHEDULED_JOBS_ENABLED` is `"true"` *and* `URL` is production. That variable is deliberately not
in wrangler.jsonc's `vars`: it is the gate that holds under `wrangler dev`, where `URL` is
inherited and does say production. Both gates log which one stopped them.

**1c is done.** One correction to the plan, and one thing the plan had right that most of the
internet does not:

- **Correction: a Worker's response is not cached by anything unless the Worker stores it.** This
  plan said the header "becomes the Cache API *or* `CDN-Cache-Control`" — only the first of those
  works. Cloudflare's CDN caches what comes back from an *origin*, and a `Response` built inside
  a Worker never passes through that, so `CDN-Cache-Control` on it is inert on its own. The Cache
  API is the mechanism (`workers/edge-cache.ts`), and a route opts in with `cache: true`. That is
  the same trap Netlify had — where the header did nothing until `cache = "manual"` appeared —
  and it fails the same silent way.
- **Not a correction: purge by tag really is available on every plan**, as this plan assumed. It
  stopped being Enterprise-only in April 2025, and most third-party write-ups are still stale on
  that. `purgeCacheTags` now purges Netlify *and* Cloudflare, each when its own credentials are
  set, so the cutover and the rollback both keep working without a code change. A throttled purge
  is reported rather than counted as done.

One header name serves both platforms: Netlify honours the standard `CDN-Cache-Control` as well
as its own, so `Netlify-CDN-Cache-Control` is gone from all 15 files that set it.

**What is cached, and what deliberately isn't.** The cache key is the URL, so a route may only
opt in where one URL is one response for everyone: the release page (the measured win — ~6,000
URLs, two Supabase queries each), plus six credential-free API reads (`artist-page`,
`release-detail`, `platforms-list`, `public-saved-artists`, `artist-lookup`, `digest-feed`).
Left uncached on purpose: `artist-page-static`, `u-handle` and `tip-page-meta`, which answer
crawlers and browsers differently at one URL; and `search-sources-v1`, `artist-lookup-v1`,
`resolve-url-v1` and `collection-art`, which vary by credential — the three v1 endpoints pick
their TTL from the caller's API key tier, and collection art belongs to one signed-in fan.
**Those four lose CDN caching at the cutover**; giving it back means keying the cache on the
credential tier, which is a job of its own and is the one piece of 1c left on the table.

**Still unverified without a Cloudflare account:** that purge-by-tag actually evicts entries
written by the Cache API. The docs say the Cache API respects `Cache-Tag` and that purge-by-tag
is plan-wide, but the two claims live in different places. Check it on the staging hostname
before the cutover — edit an artist, then confirm their release page re-renders.

**What the port turned up, which the plan didn't anticipate:**

- **The background handshake had to go now, not in 1b.** `request-persist.ts`, `request-catalog.ts`
  and `me-bandcamp.ts` POST to a background function and read the 202 as "accepted". Pointed at
  the Worker's own hostname, that call leaves Cloudflare and comes straight back into our own
  zone — which is precisely where free-plan Bot Fight Mode challenged every function-to-function
  call for six days in October and cost us release cataloguing. Moving the app onto that zone
  would have aimed the handshake into the thing that broke it. `api/lib/background.ts` installs a
  dispatcher per request (`AsyncLocalStorage`, so concurrent requests can't cross), and a caller
  that doesn't find one still makes the HTTP call — which is what keeps `npm run dev` and the
  tests working.
- **Turning the typecheck on found real bugs.** `workers/tsconfig.json` covers every handler and
  renderer the Worker imports, which is most of what `api/tsconfig.json`'s include list never
  reached. It surfaced nine nullable-client dereferences in `saved-artists.ts`, two in
  `me-location.ts`, and nine `.abortSignal()` calls in the edge renderers placed *after*
  `.single()` / `.maybeSingle()`, where the type no longer has the method — working today only
  because the runtime object happens to still be the same instance.
- **`@cloudflare/workers-types` declares `process: any`,** which silently turned every
  `process.env.X` read into `any` and took its callers' inference with it. The types `wrangler
  types` generates don't, so that is what the Worker uses; `worker-configuration.d.ts` is
  generated and committed, and must be regenerated when `wrangler.jsonc` changes.
- **Probing for a static asset consumes the request body.** Handing the `Request` to the assets
  binding before routing left every POST with a body the adapter could no longer read. The asset
  probe is now GET/HEAD only — where there was never a body to lose.
- **The assets binding 307-redirects `/index.html`** under its default `html_handling`, which is
  the one path the Worker asks for by name every time it serves the SPA. `"html_handling": "none"`.
- **Static files never run the Worker,** which is what makes them free — so their headers can't
  come from the Worker. `apps/web/public/_headers` carries them, the CSP is stated in both
  places, and a test keeps the two copies identical.
- **`api/edge/*.ts` has to run on both runtimes until Netlify is retired.** Deno has no `process`
  and the Worker has no `Deno`, so configuration is read through `edgeEnv()`. Supabase stays an
  `esm.sh` URL import there, since npm support on Netlify's edge is still beta and this is also
  the rollback path; wrangler's `alias` points it at the npm package when it bundles.
- **`social-card` can't run on Workers** — `readFileSync` for fonts, plus resvg's wasm. It is
  proxied to the Netlify site, which is up anyway for the rollback window, and is already
  scheduled for deletion now that #649 draws cards in the generator. Phase 0.3's follow-up
  removes the function, the proxy and the route together.

### What Brandon has to do

Phase 1 is on `main` and running on Netlify; nothing has been deployed to Cloudflare. The order
below is chosen so that **no step before the last one can affect what fans see or what production
data says**, and so that the last step is a reviewed, merged PR rather than a command someone runs.

**Two corrections this order is built around (2026-10-21).**

- *Routes are inherited.* A Worker route claims its hostname on deploy, and wrangler's `routes`
  key is inherited by named environments. When `unstream.stream` was listed at the top level of
  `wrangler.jsonc`, the first deploy *was* the cutover, and `wrangler deploy --env staging` would
  have reassigned the production domain to the staging Worker — wrangler said so, but only as a
  warning. Now no config names the production hostname until the cutover PR adds it, and a test
  fails if any form of route points at it.
- *A code review found six more launch blockers in the first rewrite of this list:* staging could
  be given the live Stripe key; `wrangler deploy` didn't build the site; www would have stopped
  redirecting; nothing would deploy the Worker after cutover; the scheduled jobs were switched on
  days early; and a staging step asked for a catalogue crawl that CLAUDE.md forbids. Each is fixed
  in code where it can be, and below where it can't.

#### The secrets

**Use `node scripts/copy-worker-secrets.mjs github|staging|production`** (`--dry-run` first). It
copies what Netlify will reveal straight into `gh secret set` / `wrangler secret bulk`, generates
`INTERNAL_FUNCTION_SECRET` and `SESSION_HASH_SECRET` fresh (only the Worker checks them), and
lists the rest with where to find each. It never prints a value.

**"Netlify's values" can't always be copied.** Netlify keeps anything marked secret write-only:
`netlify env:get` answers with sixteen asterisks and the last four characters, and its dashboard
won't reveal it either. Eleven of these are like that (the Supabase service key and JWT secret, the
Upstash token, both generated secrets, the Bandcamp key, the Sentry auth token, the Mirlo and
Resend keys, and both Stripe values), so they come from where they were made. The script detects
the masked form and never copies it. Staging and production are separate Workers
(`unstream-staging` and `unstream`) with separate secret stores.

**Every one of these must be a Secret, never a plain-text Variable — the two flags above all.**
`wrangler deploy` replaces the Worker's plain-text variables with `wrangler.jsonc`'s `vars` and
carries forward only secrets, so anything added in the dashboard as a "Text" variable is deleted by
the next deploy — and from step 8 on, every merge is a deploy. `SCHEDULED_JOBS_ENABLED` lost that
way stops the sweep and the tips notifier with no error. If you use the dashboard, choose the
*Secret* type.

| Secret | Production Worker | Staging Worker |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET` | Netlify's values | **Same** — staging uses production's database |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Netlify's values | Same |
| `INTERNAL_FUNCTION_SECRET`, `SESSION_HASH_SECRET` | Netlify's values | Same |
| `BANDCAMP_CREDENTIAL_KEY` | Netlify's value | **Same — must be.** It decrypts the stored Bandcamp credentials; a different key can't read them |
| `SENTRY_DSN`, `ADMIN_EMAIL`, `ALLOWED_API_EMAILS` | Netlify's values | Same |
| `ALGOLIA_API_KEY` | **Netlify's `ALGOLAI_API_KEY`** — misspelled there, so Netlify has been skipping Even search; the Worker gets the right name (`ALGOLIA_APP_ID` has a default in the code) | Same |
| `MIRLO_API_KEY` | From Mirlo's 2026-08-02 email granting it — write-only in Netlify | Omit — only catalogue crawls use it |
| `RESEND_API_KEY`, `BUTTONDOWN_API_KEY` | Netlify's values | Same — and, like `npm run dev`, staging can then send real email |
| `NTFY_SERVER_URL`, `NTFY_TOPIC` | Netlify's values | Omit — only the scheduled tips notifier uses them, and staging runs no schedules |
| `NTFY_TOKEN` | **From your ntfy account — Netlify has none**, so the notifier can't push today | Omit |
| `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_PURGE_TOKEN` | From step 2 | Same — an edit made on staging changes production data, so it should purge production's cache |
| `NETLIFY_SITE_ID`, `NETLIFY_API_TOKEN` | Netlify's values, **until Netlify is retired** — both CDNs are purged while both can serve | Same |
| **`STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`** | Netlify's **Production** context — the live key | **Netlify's Deploy Preview context — the `sk_test_` key, never the live one.** A live key on staging turns a test tip into a real charge. The code now refuses one anyway (`stripeMode()` switches tips off for a live key outside production), but don't rely on the safety net |
| **`RELEASE_CATALOG_ENABLED`** | `true` | **Omit.** CLAUDE.md: anything sharing production Supabase writes real catalogue rows and spends the real crawl budget |
| **`SCHEDULED_JOBS_ENABLED`** | `true` — **only at step 12**, not before | **Never** |
| `URL`, `SITE_NAME`, `SENTRY_ENV` | Set by `wrangler.jsonc` — don't add | Set by `wrangler.jsonc` — don't add |
| `SENTRY_RELEASE` | Set per deploy by the workflow — don't add | Same |
| `CONTEXT`, `COMMIT_REF`, `COMMIT_SHA`, `SITE_ID`, `NODE_ENV` | Netlify-only; don't add | Don't add |

If `wrangler secret bulk` says the Worker doesn't exist yet, deploy it first (the workflow, by
hand) and set the secrets straight after — both Workers are on hostnames no fan uses until step 11.

#### Before anything is deployed

1. **Enable Workers Paid** ($5/month) on the Cloudflare account that holds the DNS zone.
2. **Make a Cache Purge API token** scoped to the `unstream.stream` zone, and note the zone id.
3. **Create the four queues** — `unstream-background`, `unstream-background-dlq`,
   `unstream-background-staging` and `unstream-background-staging-dlq`. A queue consumer with no
   queue behind it fails the deploy.
4. **Move www's redirect to Cloudflare.** Create a Single Redirect rule for `www.unstream.stream`
   → `https://unstream.stream` + the same path, preserving the query string, 301 — the same rule the
   three spare domains already use. Safe to do now: today Netlify answers www with that exact
   redirect, so nothing a visitor sees changes, and it stops depending on Netlify before the
   cutover rather than after. Check: `curl -I https://www.unstream.stream/foo?x=1` →
   `301 location: https://unstream.stream/foo?x=1`, now without an `x-nf-request-id` header.
5. **Allow staging's sign-in.** In Supabase → Authentication → URL Configuration, add
   `https://next.unstream.stream/**` to the redirect URLs. Without it a magic link sent from
   staging lands you signed in on *production*, and step 7's sign-in check would pass while testing
   the wrong site.

#### Staging — `next.unstream.stream`

6. **Give GitHub what the build needs, set staging's secrets, then deploy staging from GitHub.**
   In GitHub → Settings → Secrets and variables → Actions, add these repository secrets:
   `CLOUDFLARE_API_TOKEN` (Cloudflare's "Edit Cloudflare Workers" token template) and
   `CLOUDFLARE_ACCOUNT_ID`; and, copied from Netlify's Production context, `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `VITE_SENTRY_DSN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT`. Then, in Settings → Environments,
   create **`production`** with *Deployment branches and tags* set to **Selected branches: `main`**,
   and **`staging`** with no rule. The workflow names one of the two on every run, and the
   `production` rule is what stops a hand-run from another branch reaching unstream.stream — a
   check GitHub makes before the job starts, which no branch's copy of the workflow can remove.
   (GitHub creates an environment the first time a run names it, *without* that rule, so create
   `production` before the first production run.) The build runs on GitHub, so it has none of the values
   Netlify injects into its own builds; Vite inlines the `VITE_*` ones into the bundle, and a build
   without them succeeds and ships a site whose sign-in says "Auth not configured". The workflow
   refuses to deploy when one is missing. Then set staging's Worker secrets (the table above) and
   run the *Deploy Worker* workflow by hand with `environment: staging`. **Not `wrangler deploy`
   from a laptop:** a local build reads your `.env`, so it would pass step 7 while hiding a missing
   GitHub secret that production's build would then ship without.
7. **Walk 1e's checklist on staging**, against real data:
   - sign in, save an artist, unsave it;
   - a tip with Stripe's test card `4242 4242 4242 4242` — it should appear as a *test* payment in
     Stripe's dashboard, never a live one;
   - **the queue:** re-sync your own Bandcamp collection in `/settings`. That enqueues
     `bandcamp-sync-background`, so it exercises the queue end to end with a write that is
     legitimately yours, and you can watch the message arrive and be acknowledged on the queue's
     page in the Cloudflare dashboard. *Catalogue crawls are not tested here* — they need
     `RELEASE_CATALOG_ENABLED`, which staging must not have; they are checked after the cutover;
   - the purge-by-tag check: load a release page twice for `cf-cache-status: HIT`, edit that
     artist, confirm it re-renders rather than serving the old copy;
   - **not indexable:** `curl -sI https://next.unstream.stream/ | grep -i x-robots-tag` →
     `noindex`. Staging serves production's data, and indexed it would duplicate every page.

#### The production Worker, not yet serving

8. **Turn on automatic deploys.** In GitHub → Settings → Secrets and variables → Actions, set the
   **variable** `WORKER_DEPLOY_ENABLED` to `true` (the secrets are already there from step 6). From
   here every merge to `main` deploys the production Worker, after `npm run verify` passes. A
   production deploy only ever runs from `main`; the workflow refuses one from any other branch.
9. **Set production's secrets** — everything in the table except `SCHEDULED_JOBS_ENABLED`, as
   Secrets — and run the workflow by hand once, from `main`. With no production hostname in the config it lands on the Worker's
   `workers.dev` address and serves no real traffic. Check it there: an artist page, a crawler
   render, `/api/v1/status`.

#### The cutover — one PR, deployed by merging it

10. **Write down the current DNS record** for `unstream.stream` — export it from the Cloudflare
    dashboard or screenshot it. Its content (the Netlify origin behind the proxy) isn't visible from
    outside, because a proxied lookup returns only Cloudflare's addresses, and rollback depends on
    it.
11. **Open the cutover PR**, containing exactly two things:
    - the one route in `wrangler.jsonc`, `{ "pattern": "unstream.stream", "custom_domain": true }`
      (the comment above `routes` has it verbatim — the apex only; www is step 4's redirect);
    - the deletion of `recatalog-sweep.yml` and `tips-review-notify.yml`.

    They are two halves of one switch: with the route and without the deletions each job runs
    twice; with the deletions and without the route, neither scheduler runs.
12. **Set `SCHEDULED_JOBS_ENABLED=true` on the production Worker as a Secret
    (`npx wrangler secret put SCHEDULED_JOBS_ENABLED`, then type `true`), then merge.** A plain-text
    dashboard Variable would be wiped by the very deploy this merge triggers. The workflow
    deploys within a few minutes of the merge, and that deploy is the moment `unstream.stream`
    moves. Setting the flag just beforehand means the two schedulers overlap for minutes rather
    than leaving a gap — harmless at these cadences, since the sweep is cooldown-protected. The
    tips notifier could double-send in that window; that is the cost of the overlap, and it is
    minutes, not the days it would have been.

    If the deploy fails with a permissions error, the API token from step 8 also needs
    *Zone → DNS → Edit* on `unstream.stream`: a custom domain writes a DNS record, and this is the
    first deploy that creates one.

**Rollback**

13. In the Cloudflare dashboard, remove the `unstream.stream` custom domain from the `unstream`
    Worker (Settings → Domains & Routes), recreate the record from step 10, and delete
    `SCHEDULED_JOBS_ENABLED` from the Worker (`npx wrangler secret delete SCHEDULED_JOBS_ENABLED`). Then revert the cutover PR, which brings the two
    workflows back so Netlify resumes the schedules. Do the dashboard steps explicitly rather than
    relying on a redeploy: removing a custom domain deletes the record Cloudflare made, and does
    not restore what was there. Keep the Netlify site for two weeks so there is something to point
    the record back at.

#### After the cutover

- **The two values Netlify had wrong:** search for an artist who is on Even and confirm an Even
  link appears (Netlify never showed one; Sentry now reports `[EVEN] ALGOLIA_API_KEY is not set`
  if the key is missing). And send yourself a test push with the ntfy token you set
  (`curl -H "Authorization: Bearer <token>" -d test <NTFY_SERVER_URL>/<NTFY_TOPIC>` in your own
  terminal) so the tips notifier's next real alert isn't the first test.

- **Catalogue crawls:** within twelve hours the Cron sweep should produce `release_catalog_state`
  rows with `last_trigger = 'scheduled'` and a recent `last_attempted_at`, and the queue's page
  should show messages consumed. Nothing new there after a day means the scheduled path is broken.
- **Sentry:** watch for the *absence* of events as much as new ones; silence and health look alike.
  Events should now carry `environment: production` and a `release` matching the deployed commit.
- **Supabase I/O:** on Netlify the `CDN-Cache-Control` rename is proven
  (`cache-status: hit; ttl=86400`); on the Worker caching goes through the Cache API instead, a
  different mechanism. A step change upward means it isn't caching.

**Optional and independent: 1f.** Pointing the Mac app and extension at an
`unstream.stream/auth/v1/*` proxy only matters for the later database move, and needs a client
release. It doesn't block anything above.

### Phase 2: Upstash → Cloudflare (no cost change)

Behind the same function signatures in `cache.ts`, `ratelimit.ts`, `feature-flags.ts` and
`redis.ts` (see "Keep it portable"):

| Today in Redis | Moves to | Why |
|---|---|---|
| Search, suggest, directory, tip-page and per-platform caches | KV with `expirationTtl` | Eventually consistent (~60 s), fine for caches |
| MusicBrainz enrichment (`mb-enriched`, 1 day) | KV, 1-day TTL | Same rule: never cache uncertainty |
| Per-minute rate-limit windows | The Workers rate-limiting binding | Approximate and per location, fine for per-minute windows |
| Daily quotas (`strict`'s 500/day, API-key tiers) | A Durable Object counter | Exact; the 500/day is a documented promise to v1 callers |
| Feature flags, tips-review-notify state, Sentry dedup | KV | Small and rarely written |

- **KV is metered too:** 1M writes a month on Workers Paid. A search can write ~10 platform cache
  entries, so that's tens of thousands of searches a month. CLAUDE.md's "Redis is metered"
  section becomes the same rule for KV writes.
- Delete `upstash-keepalive.yml` and the Upstash env vars; close the account.
- **Rollback:** revert the PR; Upstash keeps working until its account is closed.

### Phase 3 (optional, when it's GA): email → Cloudflare Email Service

Not urgent: Resend is inside its free tier, the swap is one file plus DNS, and nothing waits on
it. Cloudflare Email Service has been in public beta since April 2026 (REST API, Workers binding,
SMTP); move when it's generally available.
- `api/lib/resend.ts` becomes a Cloudflare Email client behind the same interface. Callers:
  `notifications.ts`, `me-email.ts`.
- SPF, DKIM and DMARC records in Cloudflare DNS.
- If Supabase's auth emails go through Resend's SMTP (Phase 0.5), point them at Cloudflare's SMTP
  too.
- Mailgun was considered and isn't the values pick: Sinch bought it in 2021 out of Thoma Bravo's
  private-equity roll-up. MailPace (small, UK) and Lettermint (Dutch, own EU infrastructure) are
  the independent fallbacks.
- **Rollback:** switch the env back; keep Resend configured for a month.

### Phase 4: GitHub → Codeberg

**Prerequisite:** Phase 1, so the app's schedules live in Cron Triggers and CI is small.

- **CI runs on Brandon's Mac Studio.** One `forgejo-runner` takes every job; Codeberg's hosted
  Actions are deliberately limited.
  - Linux jobs run in containers through Colima (open source); `mac-build` runs in host mode for
    Xcode.
  - Run it under its own macOS user account, so jobs can't read Brandon's files.
  - **Contributors' PRs run on the Mac.** Forgejo holds a fork PR's workflows until someone with
    write access approves them, and approving runs whatever the PR changed, workflow files
    included. Read its `.forgejo/` diff first, and keep secrets out of PR-triggered jobs.
- **Deploys:** Cloudflare's Git-connected builds support GitHub and GitLab, not Codeberg. Pick
  one at the time:
  - **`wrangler deploy` from the Mac runner.** Simplest; a sleeping Mac delays releases, and
    Phase 0.4's alert says so.
  - **Codeberg push-mirrors to a read-only GitHub repo** that Cloudflare builds from. Production
    never waits on the Mac, at the price of GitHub staying in the loop as a mirror.
- **Scheduled jobs left in CI** (`db-backup` nightly, social posts on Mondays, the digest on
  Fridays) run only while the Mac is awake, and **a job that never starts never fails**, so
  `db-backup`'s "backup failing" issue would never open. Each job pings Healthchecks.io when it
  succeeds, alongside Phase 0.4's heartbeat.
- **Port the remaining workflows** to `.forgejo/workflows/` (largely GitHub Actions syntax):

  | Workflow | Notes |
  |---|---|
  | `ci.yml` | Straight port |
  | `supabase-migrate.yml`, `db-backup.yml` | Straight ports |
  | `semantic-revert-check.yml` | Its PR comments use the GitHub API; port to Forgejo's |
  | `mac-build.yml` | Host mode on the Mac Studio |
  | `industry-digest.yml` | Publishes to a branch; `digest-feed.ts` reads `raw.githubusercontent.com`, so switch it to Codeberg's raw URL and update the SSRF allowlist |
  | `schedule-social-posts.yml` | Commits back; needs a Codeberg push token |
  | `weekly-analytics-recap.yml` | Paused; port or delete |

- **Lost GitHub integrations:** GitGuardian → `gitleaks` in CI; the automated PR review bot →
  port it or drop it.
- **Links that point at GitHub:**
  - "Codebase" and "Roadmap" in the server-rendered pages' footers (`artist-page-static`,
    `u-handle`, `release-page`), and the Press page's "Open source on GitHub".
  - Mac DMG downloads in `api/shared/desktop-release.ts`: move them to Codeberg releases or R2.
    Sparkle's appcast is already served from `unstream.stream`.
- **Linear → Forgejo issues:** a one-off script from Linear's export, plus a `UNS-n → #m` mapping
  file in `docs/` so old commit references still resolve.
- **Working with agents afterwards:** Claude Code's cloud sessions and its GitHub PR tooling are
  GitHub-only. Work moves to Claude Code on the Mac, which works with any git remote.
- **Rollback:** GitHub stays as a mirror until Codeberg has run cleanly for a month.

### Phase 5 (optional): Sentry → GlitchTip

GlitchTip is open source and accepts the Sentry SDK, so the change is the DSN. Decide when the
rest is done.

## Later: the database

Supabase stays for data and sign-in. **The outages** come from Supabase's own services exceeding
the free Nano instance's memory (disk I/O investigation, Round 7), not from Unstream's load.
**Supabase Pro ($25/month) is the fix**; upgrade when the outages cost more than that.

### The recommended route off Supabase: Supabase's own stack on Hetzner

Decided 2026-10-19, for when leaving Supabase the company is worth it. What makes leaving
expensive is the shape of the code (`supabase-js`, PostgREST, Supabase Auth), not the company.
Supabase's stack is open source, so running it elsewhere keeps everything as it is:
- the 373 query call sites and 20 Postgres functions;
- RLS, migrations and the nightly backup;
- sign-in in all three clients.

**Hetzner:** a privately owned German host, not VC-backed, running its own data centres. Its US
location is Ashburn, Virginia, near Supabase's current region; Falkenstein, Nuremberg and
Helsinki are the EU options. Smart Placement keeps the Worker near whichever is chosen. A
self-hosted Unstream could ship on the same stack.

Two ways to run it:

| | **Elestio** (preferred) | **Coolify on a Hetzner server** (fallback) |
|---|---|---|
| What it is | A managed service that deploys and operates Supabase's stack on a server at the provider you pick, Hetzner included | An open-source self-hosting panel (Coolify Cloud at $5/month, or self-hosted) that deploys Supabase's Docker stack on a Hetzner server Brandon rents |
| Upkeep | Elestio: updates, backups, monitoring | Brandon, with Coolify's help: upgrades, disk, restores |
| Billing | Elestio's plan for the server size, from prepaid credits. **Instances stop when credits run out** unless auto-recharge is on, so turn it on | Hetzner's server plus Coolify |
| Unknowns | Elestio's ownership and funding (not found on 2026-10-19). Check before choosing | None beyond the upkeep |

Size the server for the whole stack (Postgres, PostgREST, GoTrue, Kong, Storage, Realtime,
Studio); Supabase's self-hosting guide gives a minimum of about 4 GB. Re-check prices when it
comes up.

**The move, in order:**
1. **Prerequisite: Phase 1f.** The Mac app and extension reach sign-in through
   `unstream.stream/auth/v1/*`, so the cutover is a server-side switch rather than a client
   release.
2. Stand up the stack. Pin Postgres's major version and GoTrue's close to hosted Supabase's.
   Keep Postgres off the public internet and Studio behind a login.
3. **Check sign-in tokens.** `middleware.ts` verifies them against a JWKS endpoint
   (`createRemoteJWKSet`); confirm self-hosted GoTrue publishes one for its signing keys. If
   hosted Supabase's signing key can't be carried over, everyone signs in once more after the
   cutover.
4. Restore the whole database, `auth` and `storage` schemas included, from a fresh dump taken
   during a short write freeze. It's the same path the nightly backup's restore check already
   proves (`docs/database-backups.md`).
5. Point the Worker's Supabase URL and keys, and the `/auth/v1` proxy, at the new stack.
   `supabase-migrate.yml` and `db-backup.yml` get the new database URL.
6. **Rollback:** point them back. Keep the hosted project, read-only, for two weeks.

Rules that carry over unchanged:
- CLAUDE.md's "`REVOKE` … from `anon, authenticated`" applies: it's the same stack with the
  same default privileges.
- PostgREST's silent 1,000-row cap applies: same software.

### Considered and not recommended (2026-10-18 and 10-19)

- **Appwrite:**
  - VC-backed: ~$37M, last a Tiger Global–led Series A in 2022.
  - Its Cloud doesn't publish which provider runs its regions.
  - Its own data and sign-in APIs mean rewriting every query and sign-in in all three clients.
  - Appwrite 2.0's direct Postgres access (September 2026) would make it just another Postgres
    host.
- **Managed Postgres elsewhere** (DigitalOcean, Scaleway, OVH). `digitalocean-database-plan.md` is
  fully planned. But from Workers it needs PostgREST hosted somewhere or the queries rewritten
  as SQL through Hyperdrive, and sign-in needs a new home either way: more work than moving
  Supabase's whole stack.
- **Cloudflare D1, or PocketBase** (SQLite): the biggest rewrite:
  - every query and the 20 Postgres functions;
  - the trigram index and pg_cron jobs;
  - the migrations;
  - replacing Supabase Auth across the web, Mac and extension clients.
- **Nhost:** VC-backed, on AWS.

## How CLAUDE.md changes, by phase

| Phase | Rule | Change |
|---|---|---|
| 0 | Database plan line | Points at this plan; the database stays on Supabase |
| 0 | Social posts: the `/api/social-card` renderer | Cards drawn by the generator, hosted on R2 (#649) |
| 1 | Architecture, Repository structure, Commands | Workers instead of Netlify Functions and Edge Functions |
| 1 | Lambda-freeze rules, `withSentry` rationale, function-to-function calls | Rewritten for `waitUntil` and Queues |
| 1 | Local dev section, deploy-preview rules | Rewritten for `wrangler dev` and version previews |
| 1 | "Edge functions" section, `netlify.toml` references | Point at the Worker's routes |
| 1 | Deployment, `netlify-ignore-*.sh` | Rewritten for Workers deploys |
| 2 | "Redis is metered" | Becomes "KV writes are metered" |
| 4 | Deployment and GitHub Actions sections | Rewritten for Codeberg and the Mac Studio runner |

Each phase's PR updates CLAUDE.md in the same change, and `docs/engineering-history.md` gets an
entry for anything learned the hard way.

## Picking this back up

Each phase is one or more agent sessions. To start one, paste:

```
Read docs/specs/infrastructure-independence-plan.md and start Phase <N>.
Re-check prices and limits it names, report what changed, then do the agent
steps and tell me exactly what I need to do myself.
```
