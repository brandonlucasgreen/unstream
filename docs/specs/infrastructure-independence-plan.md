# Infrastructure independence: Netlify → Cloudflare, GitHub → Codeberg

**Date:** 2026-10-18
**Status:** Decided (Brandon, 2026-10-18). Not started.
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
far higher outbound limits, 1M KV writes and 1M Queue operations a month. Re-check the numbers
before Phase 1.

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

**1b. Background jobs and schedules**
- **Search persistence:** `ctx.waitUntil()` after the response. `request-persist.ts` and the
  persist background function go away.
- **Catalogue crawls and the Bandcamp collection sync** become Queue consumers:
  - Queues gives retries, a dead-letter queue, concurrency as a setting (the crawl pacing budget)
    and a visible backlog. "Is cataloguing running?" becomes a glance; it would have caught the
    six days nothing was catalogued.
  - The internal HTTP handshakes, `internal-origin.ts` and the function-to-function
    `INTERNAL_FUNCTION_SECRET` checks for these jobs go away.
  - Check a consumer's per-invocation limits against the longest discography crawl; split work
    per page if needed.
- **Schedules:** the catalogue sweep and the tips-review notifier become Cron Triggers, and
  `recatalog-sweep.yml` and `tips-review-notify.yml` go away.

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
  build allowance**.

**1e. Cutover**
- Deploy to the Worker's `workers.dev` address and a staging hostname (e.g.
  `next.unstream.stream`). Walk through:
  - search, artist and release pages, and the edge-rendered pages as a crawler (curl with a
    Googlebot user agent);
  - sign-in, saves, and tips in test mode;
  - feeds, `/appcast.xml` and the Queue-driven catalogue crawl.
- **Cutover:** route `unstream.stream` to the Worker.
- **Rollback:** route it back to Netlify. Keep the Netlify site, idle, for two weeks.

**1f. Recommended: own the auth URL.** Not needed while Supabase stays, but it is the
prerequisite for the later database route (see "Later"). Point the clients' auth at an
`unstream.stream/auth/v1/*` proxy instead of the hard-coded `supabase.co` address
(`AuthService.swift`, `lib/supabase.js`), in the next Mac and extension releases. A later
database move (or a self-hosted build) then needs no client release.

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
