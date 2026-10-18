# Infrastructure independence: moving Unstream to DigitalOcean and Forgejo

**Date:** 2026-10-18
**Status:** Decided (Brandon, 2026-10-18). Not started.
**Supersedes:** the 2026-10-06 decision to make Supabase Pro the next step. The database move in
`digitalocean-database-plan.md` is no longer the fallback; it is Phase 1 of this plan.

## Why

Unstream should run, as far as practical, on providers that are **not venture-funded and not a
hyperscaler (AWS, Google, Microsoft)**, without Brandon becoming a systems administrator. Today
almost every layer fails that test:

| Layer | Today | Owner / runs on |
|---|---|---|
| Database + Auth | Supabase (free Nano) | VC-backed, AWS |
| Functions, edge, CDN, deploys | Netlify (free) | VC-backed; Functions run on AWS Lambda |
| Cache, rate limits, flags | Upstash Redis (free) | VC-backed, AWS/GCP |
| Transactional email | Resend (free) | VC-backed |
| Code, CI, scheduled jobs | GitHub + Actions | Microsoft |
| Issues | Linear | VC-backed |
| Error tracking | Sentry | VC-backed |

There are two practical reasons as well:
- **The free Nano database is what causes the outages.** Supabase's own services hold ~1.27 GB
  committed and ~400 MB of swap on a 0.5 GB machine (disk I/O investigation, Round 7).
- **Netlify's free plan is close to its cap.** 300 credits a month at 15 per production deploy,
  and every site pauses when it runs out. Main had ~50 deploying commits from 2026-10-04 to 10-18.

## Where it ends up

| Layer | Target | Owner | Notes |
|---|---|---|---|
| Database | DigitalOcean Managed PostgreSQL, NYC3 | Public company (NYSE: DOCN), own infrastructure | Daily backups, 7-day point-in-time restore, 1 GB for Postgres alone |
| Data API | PostgREST container on App Platform | open source | Keeps every `supabase-js` data call working unchanged |
| App | One Node server container on App Platform | DigitalOcean | API, server-rendered pages, background jobs, static files |
| Auth | GoTrue (Supabase's open-source auth server) container on App Platform, data in the managed database | open source | Supabase gone entirely |
| CDN + DNS | Cloudflare (stays) | Public company (NYSE: NET), own network | Cache by tag, purge by tag on the free plan |
| Cache, rate limits, flags | In-process memory + Postgres | — | Upstash gone |
| Email | Resend for now; an independent provider when there's a reason | — | Not urgent; candidates in Phase 4 |
| Code, issues | Forgejo: Codeberg, or a private instance | Codeberg is a non-profit (Codeberg e.V.) | Codeberg needs an open-source license; see Phase 6 |
| CI | A Forgejo runner on Brandon's Mac Studio | — | Production never waits on it |
| Error tracking | Sentry for now; GlitchTip optional | — | GlitchTip speaks the Sentry SDK |
| Stays as is | Stripe, GoatCounter, Buttondown, Cloudflare R2 (backups) | — | No equivalent for Stripe Connect; GoatCounter and Buttondown are indie |

**Region: NYC3** for everything on DigitalOcean. Traffic is a mix of US and EU; New York is
~70–90 ms from both Western Europe and the US West Coast, and Cloudflare serves cached responses
from near each visitor. App, PostgREST, GoTrue and the database share NYC3's private network.

**The alternative, if EU hosting is ever preferred:** Scaleway (Iliad group, not VC-backed) has
managed Postgres, serverless containers and transactional email in Paris/Amsterdam/Warsaw. The
architecture below is portable to it; only the provider-specific steps (doctl, app spec) change.

### What was considered and ruled out (2026-10-18)

- **Supabase Pro:** fixes the outages for $25, but stays VC-backed and on AWS.
- **Self-managed VPS (Hetzner, or Coolify on a VPS):** most independent, but the database's
  durability (backups, restores, upgrades, disk) would be Brandon's. Coolify Cloud ($5 + a server)
  is a credible way to run the *stateless* app later if wanted; the database stays managed either way.
- **Bunnyshell:** VC-backed (Early Game Ventures, ~$10M), and a Kubernetes layer on top of a cloud
  rather than a host.
- **Bunny.net:** took VC (Runa Capital, 2022); no managed Postgres.
- **Render, Railway, Fly, Koyeb, Neon, Aiven, Ubicloud:** VC-backed or acquired.
- **EthicalHost.ca and similar shared hosts:** built for WordPress-style sites; no Node app
  hosting or managed Postgres. Good homes for simple sites, not for Unstream.
- **Cloudflare Workers for the app:** not VC-backed and not AWS, but a different runtime and a
  dominant company; App Platform keeps Unstream on plain Node.

## Cost

| | Monthly |
|---|---|
| Managed Postgres, 1 GB | ~$15 |
| PostgREST container (512 MB) | $5 |
| App container (1 GB) | $10 |
| GoTrue container (512 MB), from Phase 5 | $5 |
| CI runner | $0 (the Mac Studio) |
| Code hosting, from Phase 6 | $0 on Codeberg; a few dollars for a managed private Forgejo |
| Email | $0 on Resend's free tier; ~$10 if it moves to a paid independent provider |
| **Total** | **~$35–50** |

App Platform includes outbound transfer (50 GB on $5 containers, 100 GB on $10), then
$0.02/GB. Prices are from DigitalOcean's pricing pages in October 2026; **re-check before each
phase**. For comparison, staying put means Supabase Pro ($25) plus a paid Netlify plan ($9–20)
once the free credits run out.

## The phases, in order

Each phase is shippable on its own, leaves the site working, and has a rollback. The order
follows the dependencies: the database first (it fixes the outages), then the app (it unlocks
removing Upstash and owning the auth URL), and the forge last (it depends on CI being small).

### Phase 0: no-cost groundwork (any time)

| # | Step | Who |
|---|---|---|
| 0.1 | Record the decision: CLAUDE.md's database plan line, the status of `digitalocean-database-plan.md`, this doc | Agent (done with this doc) |
| 0.2 | Think about the license question in Phase 6; nothing waits on it until then. Once it's settled, a **pull mirror** of the GitHub repo on the chosen forge puts the code somewhere independent early | Brandon |
| 0.3 | Check Netlify billing: credit pricing or the legacy plan, and how many credits are left. Until Phase 2, batch merges so several PRs ship in one deploy | Brandon |
| 0.4 | Measure email volume, to know whether a free tier covers it (Phase 4): `select date_trunc('day', created_at) d, count(*) from email_log group by 1 order by 1 desc limit 30;` | Brandon, SQL editor |
| 0.5 | In Supabase → Authentication → SMTP, note whether auth emails use Supabase's built-in sender or a custom SMTP (Resend). Phase 5 needs it | Brandon |

### Phase 1: the database (≈ $20/month starts)

Follow `digitalocean-database-plan.md` from "Picking this back up". It is complete; this plan
adds four corrections found on 2026-10-18:

- **New data call site:** `api/edge/tip-page-meta.ts` reads `SUPABASE_URL` /
  `SUPABASE_SERVICE_KEY` (added after the plan was written). Switch it with the other edge
  functions.
- **Check `me-email-confirm.ts`** (email-change flow, added 2026-10-16): classify each Supabase
  call as data or Auth-admin, like the plan's two "traps".
- **`schedule-social-posts.yml` no longer holds Supabase secrets** (#577), so drop it from the
  plan's list of call sites.
- **New since the plan:** search persistence and catalogue requests run in background functions
  (#641, #642). They use `db.ts`'s `getClient()`, so the plan's env split covers them.

Sign-in stays on Supabase through Phases 1–4. Only data moves.

**Rollback:** unset `DATA_API_URL` / `DATA_API_SERVICE_KEY` and redeploy (the plan's §7).

### Phase 2: the app, off Netlify (≈ +$10/month; Netlify goes to $0)

The largest phase. Do it as **lift-and-shift first, simplify second**, so the first cutover
changes hosting and nothing else.

**2a. One Node server that runs the existing code unchanged**
- `server/` (new): a small Node HTTP server (Hono, or plain `node:http`).
  - **Function adapter:** turns each request into the Lambda-style `event` the 67 handlers already
    take and maps their `{ statusCode, headers, body }` back. Handlers stay untouched.
  - **Routes:** generated from `netlify.toml`'s 72 redirects, so `/api/*` and the feed URLs keep
    their paths. A test asserts every `[[redirects]]` entry has a route.
  - **Headers:** the 3 `[[headers]]` blocks (including CSP) become middleware with the same values.
  - **The 7 edge functions:** ported from Deno to Node modules. Replace `esm.sh` imports with npm
    packages, `Deno.env.get` with `process.env`, and `context.next()` with "serve the SPA's
    `index.html`". The crawler/browser split in `artist-page-static` and `u-handle` keeps its
    one-route-one-renderer shape: decide per request, before any query.
  - **Static files:** serve `apps/web/dist` with long-lived cache headers on hashed assets and
    `index.html` as the fallback.
  - **The 3 background functions:** for parity, keep their HTTP endpoints (answer 202, run the work
    in-process after responding). `internalFunctionOrigin()` points at the server itself through a
    new `INTERNAL_ORIGIN` env var.
- `Dockerfile`: `npm ci`, `npm run build` (the generators still run before `vite build`), start
  the server.
- `infra/digitalocean/app.yaml`: the app spec with the app, PostgREST and (later) GoTrue
  components, env vars as encrypted secrets, health check on `/api/health/db`.

**2b. Caching moves from Netlify's CDN to Cloudflare's**
- `Netlify-CDN-Cache-Control` becomes `CDN-Cache-Control`, which Cloudflare honours. Release
  pages (#638) and the other cached API responses keep their TTLs.
- Cloudflare **Cache Rules** make the cached paths eligible; by default Cloudflare only caches
  static file types. The crawler-split pages (`/a/<slug>`, `/artist/*`, `/u/*`, `/tip/*`) get **no**
  cache rule: the cache key is the URL, the same reason they aren't cached on Netlify.
- `purge-cache.ts`: Netlify's purge API becomes Cloudflare's purge-by-tag, which is on the free
  plan at 5 purge requests a minute. `Cache-Tag` keeps its name.
- Check whether Cloudflare honours `stale-while-revalidate` on the free plan; if not, plain TTLs
  are fine.

**2c. Own the auth URL (sets up Phase 5)**
- Add a proxy route `unstream.stream/auth/v1/*` → `bwogclqzpsbvqbyhhqbz.supabase.co/auth/v1/*`.
- Point every client's "Supabase URL" for auth at `https://unstream.stream`:
  - the web app, through its build-time env;
  - **the Mac app (`AuthService.swift`) and the extension (`lib/supabase.js`), which hard-code
    the `supabase.co` URL today**;
  - `middleware.ts`'s JWKS fetch.
- Ship a Mac release (Sparkle) and an extension release with the change. **Phase 5 can't start
  until most installs have updated**, so do this early.

**2d. Cutover**
- Run the DigitalOcean app on its `ondigitalocean.app` hostname and on a staging hostname such
  as `do.unstream.stream`. Walk through search, artist and release pages, sign-in, saves, tips
  in test mode, feeds, `/appcast.xml` and the edge-rendered pages as a crawler (curl with a
  Googlebot user agent).
- Point `recatalog-sweep.yml` and `tips-review-notify.yml` (which call `unstream.netlify.app`
  today) at the new host.
- **Cutover:** in Cloudflare DNS, point `unstream.stream` at App Platform.
- **Rollback:** point it back at Netlify. Keep the Netlify site, idle, for two weeks.

**2e. Simplify, once stable**
- Background work runs in-process directly. Remove the HTTP handshakes: `request-persist.ts`,
  `request-catalog.ts`'s POST, `internal-origin.ts`, and the Lambda-freeze rules in CLAUDE.md.
  Catalogue crawls go through an in-process queue with concurrency 1, which keeps the existing
  pacing budget.
- Replace Netlify-only machinery: `scripts/netlify-ignore-*.sh`, `netlify.toml`, the
  `withSentry` flush rationale (the flush stays harmless), and `npm run dev`. Local dev becomes
  the same server plus Vite, which removes the `netlify dev` traps from CLAUDE.md.
- **What's lost:** per-PR deploy previews. App Platform has no free equivalent. Use local dev
  and the staging hostname; add a $10 staging app later only if missed.

### Phase 3: Upstash, gone (no cost change)

Upstash exists because Netlify functions keep no memory between runs. The App Platform server
does, so everything behind `cache.ts`, `ratelimit.ts`, `feature-flags.ts` and `redis.ts` moves
behind the same function signatures:

| Today in Redis | Moves to | Why |
|---|---|---|
| Per-minute rate-limit windows | Memory | A reset on deploy is harmless |
| Daily quotas (`strict`'s 500/day, API-key tiers) | Postgres counters | The 500/day is a documented promise to v1 callers |
| Search, suggest, directory and tip-page caches | Memory | They refill |
| MusicBrainz enrichment (`mb-enriched`, 1 day) and per-platform search caches | An `UNLOGGED` Postgres cache table with expiry, pruned nightly by pg_cron | Refetching after every deploy would hit MusicBrainz's 1 request/second limit |
| Feature flags (`tipsArtists`, `tipsFans`) | A Postgres table | Settings, not cache |
| Sentry dedup, tips-review-notify state | Memory / Postgres respectively | |

- One migration: server-only tables with RLS enabled and no policies, per CLAUDE.md.
- **The assumption to write into CLAUDE.md:** this needs **one app instance**. Two or more would
  not share memory, and would need a shared store again (DigitalOcean Managed Valkey, ~$15/month).
- Delete `upstash-keepalive.yml`, the Upstash env vars, and the "Redis is metered" section of
  CLAUDE.md.
- **Rollback:** revert the PR; Upstash keeps working until its account is closed.

### Phase 4 (optional, any time): email off Resend

**Not urgent.** Resend is VC-backed, but Unstream is inside its free tier, the swap is one file
plus DNS, and nothing else waits on it: GoTrue (Phase 5) can send through Resend's SMTP as well
as anyone's. Move when there's a reason (volume outgrows the free tier, Resend's terms change)
or a provider worth moving to.

**Mailgun isn't the values pick.** It was the first idea for its free tier, but it belongs to
Sinch, a large public messaging company that bought it in 2021 out of Thoma Bravo's
private-equity roll-up (Pathwire). Better fits, as of October 2026; verify ownership and
pricing before choosing:

| Provider | What it is | Watch out for |
|---|---|---|
| MailPace | Small UK company (formerly OhMySMTP); transactional only, EU-hosted, no open or click tracking | Paid from low volume (~$10/month for 10k); the free tier is tiny |
| Lettermint | Dutch; runs on its own EU infrastructure, with no US cloud underneath | Young; funding not public; free tier ~300/month |
| Cloudflare Email Service | Sending from a vendor already in the stack (REST API, SMTP); public company | Public beta since April 2026; wait for general availability |
| Scaleway Transactional Email | Iliad group, EU | Only worth it if other things move to Scaleway |

Phase 0.4's volume count decides between a free tier and ~$10/month.

The work, whichever provider:
- `api/lib/resend.ts` becomes a client for the new provider behind the same interface. Callers:
  `notifications.ts`, `me-email.ts`.
- DNS in Cloudflare: the provider's SPF and DKIM records, and a DMARC policy.
- If auth mail goes through Resend today (Phase 0.5), point Supabase's SMTP settings (later
  GoTrue's) at the new provider too.
- **Rollback:** switch the env back; keep Resend configured for a month.

### Phase 5: sign-in, off Supabase (≈ +$5/month)

**Prerequisite:** Phase 2c's Mac and extension releases are on most installs.

- Add a GoTrue component to the app spec, pinned to the version Supabase currently runs, with
  its data in an `auth` schema in the DigitalOcean database.
- **Migrate the `auth` schema** (users, identities, sessions, refresh tokens) from Supabase with
  `pg_dump`, preserving GoTrue's own migration table so it doesn't re-run migrations.
- **Keep everyone signed in:**
  - **Old tokens:** existing access tokens are signed with Supabase's key and expire within an
    hour. `middleware.ts` trusts both JWKS endpoints during the switch.
  - **Refresh tokens** move with the schema, so clients refresh against GoTrue and get its tokens.
- Configure GoTrue: site URL and redirect allowlist (`unstream.stream`, the Mac app's and the
  extension's callback URLs), email templates, and SMTP (Resend's, or Phase 4's provider).
- **Cutover:** flip the `/auth/v1/*` proxy from Supabase to GoTrue. Rehearse it on the staging
  hostname first, with a test account through sign-up, magic link, password sign-in and
  refresh, on web, the Mac app and the extension.
- Restore the foreign keys to `auth.users` that Phase 1 dropped; the users table is local again.
- **Rollback:** flip the proxy back. Sessions refreshed against GoTrue since the flip become
  invalid at Supabase, so those users sign in again. Keep the window short.
- After two quiet weeks: final backup of the Supabase project, then delete it.

### Phase 6: GitHub → Forgejo (≈ $0–4/month)

**Prerequisite:** Phases 2–3, so the app's scheduled jobs live in the server and CI is small.

**Decide first where the repository lives.** Codeberg hosts only projects under an OSI- or
FSF-approved license, and Unstream has none: a public repository with no license is "all rights
reserved". So:
- **Codeberg means choosing a license.** AGPL-3.0 fits Unstream best: anyone who runs a modified
  copy as a service has to publish their changes. It's a lasting product and legal decision, so
  it's Brandon's.
- **Without one, use a private Forgejo** and collaborate there by invitation: a managed instance
  from a small host (PikaPods, for example, at a few dollars a month), or Forgejo on the Mac
  Studio behind a Cloudflare Tunnel, which makes the forge itself depend on the Mac.

- **Move app-level schedules in-process first** (`node-cron` in the server): the catalogue sweep
  and the tips-review notifier. Their workflows go away.
- **CI runs on Brandon's Mac Studio.** One `forgejo-runner` takes every job; Codeberg's hosted
  Actions are deliberately limited.
  - Linux jobs run in containers through Colima (open source), so Docker Desktop isn't needed;
    `mac-build` runs in host mode for Xcode.
  - Run it under its own macOS user account, so jobs can't read Brandon's files.
  - **Contributors' PRs run on the Mac.** Forgejo holds a fork PR's workflows until someone with
    write access approves them, and approving runs whatever the PR changed, workflow files
    included. Read its `.forgejo/` diff first, and keep secrets out of PR-triggered jobs.
- **Nothing in production may wait on the Mac being on:**
  - **Deploys:** App Platform builds the app itself from the repository's public clone URL. A
    Forgejo push webhook calls a small signed endpoint in the app, which asks DigitalOcean to
    deploy, so a sleeping Mac delays CI, not a release. A private repository can't be cloned
    that way: there the runner builds an amd64 image and pushes it to DigitalOcean Container
    Registry ($0–5/month), and deploys do wait on the Mac.
  - **Scheduled jobs** (`db-backup` nightly, social posts on Mondays, the digest on Fridays) run
    only while the Mac is awake and online, and **a job that never starts never fails**, so
    `db-backup`'s "backup failing" issue would never open. Add a dead man's switch: each job
    pings Healthchecks.io (open source, run by a one-person company) when it succeeds, and it
    emails when a ping is late. From Phase 1, DigitalOcean's own daily backups mean a missed
    night costs the second copy, not the only one.
- **Port the remaining workflows** to `.forgejo/workflows/` (largely GitHub Actions syntax):

  | Workflow | Notes |
  |---|---|
  | `ci.yml` | Straight port |
  | `supabase-migrate.yml` | Already rewritten for DigitalOcean in Phase 1 |
  | `db-backup.yml` | Straight port; still valuable as the off-provider copy |
  | `semantic-revert-check.yml` | Its PR comments use the GitHub API; port to Forgejo's |
  | `mac-build.yml` | Host mode on the Mac Studio |
  | `industry-digest.yml` | Publishes to a branch; `digest-feed.ts` reads `raw.githubusercontent.com`, so switch it to the forge's raw URL and update the SSRF allowlist |
  | `schedule-social-posts.yml` | Commits back; needs a push token for the forge |
  | `weekly-analytics-recap.yml` | Paused; port or delete |

- **Lost GitHub integrations:**
  - GitGuardian → `gitleaks` in CI.
  - The automated PR review bot → port it or drop it.
  - Supabase's and Netlify's GitHub apps are already gone by then.
- **Links that point at GitHub:**
  - "Codebase" and "Roadmap" in the edge pages' footers (`artist-page-static.ts`, `u-handle.ts`,
    `release-page.ts`).
  - Mac DMG downloads in `api/shared/desktop-release.ts`: move them to the forge's releases or R2.
    Sparkle's appcast is already served from `unstream.stream`.
- **Linear → Forgejo issues:** a one-off script that reads Linear's export and creates issues,
  labels and milestones on the new forge, plus a `UNS-n → #m` mapping file in `docs/` so old commit
  references still resolve.
- **Working with agents afterwards:** Claude Code's cloud sessions and its GitHub PR tooling
  are GitHub-only. Work moves to Claude Code on the Mac, which works with any git remote; agents
  push branches and open PRs through Forgejo's API or CLI. Optionally keep GitHub as a read-only
  mirror for tools that need it.
- **Rollback:** GitHub stays in place as a mirror until the new forge has run cleanly for a month.

### Phase 7 (optional): Sentry → GlitchTip

GlitchTip is open source and accepts the Sentry SDK, so the change is the DSN. Hosted GlitchTip is
run by a small company; self-hosting needs Postgres plus Valkey and isn't worth it at this size.
Decide when the rest is done.

## How CLAUDE.md changes, by phase

| Phase | Rule | Change |
|---|---|---|
| 0 | "Plan: stay on the free plan…" | Replaced with a pointer to this plan |
| 2 | Lambda-freeze rules, `withSentry` rationale | Relaxed |
| 2 | `netlify dev` traps | Rewritten for the new local dev |
| 2 | Deploy-preview rules | Rewritten for the new local dev |
| 2 | "Edge functions" section | Becomes "server-rendered pages" |
| 2 | `netlify.toml` references | Point at the server's route table |
| 3 | "Redis is metered" | Deleted |
| 3 | One-instance assumption | Added |
| 5 | Auth section | Rewritten |
| 5 | "`REVOKE` … on Supabase" | Kept: Supabase-specific default privileges no longer apply on DigitalOcean, but the habit is harmless |
| 6 | Deployment and GitHub Actions sections | Rewritten for Forgejo and the Mac Studio runner |

Each phase's PR updates CLAUDE.md in the same change, and `docs/engineering-history.md` gets an
entry for anything learned the hard way.

## Picking this back up

Each phase is one or more agent sessions. To start one, paste:

```
Read docs/specs/infrastructure-independence-plan.md and start Phase <N>.
Re-check prices and anything the phase says to re-check, report what changed,
then do the agent steps and tell me exactly what I need to do myself.
```

For Phase 1, the database plan's own "Picking this back up" applies, with the four corrections
under Phase 1 above.
