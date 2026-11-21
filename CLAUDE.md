# Unstream - Development Guide

## Project overview

Unstream helps music listeners find their favorite artists on alternative platforms outside streaming, so they can support artists directly. It searches 17+ platforms (Bandcamp, Mirlo, Ampwall, Subvert, Beatport, Faircamp, Jam.coop, Patreon, etc.) and shows verified links grouped by category with artist payout percentages. On Bandcamp Fridays, results highlight the platforms that pay artists 100%. Runs at [unstream.stream](https://unstream.stream).

**This file is the short rulebook every session loads**: the rules that apply to any change, the commands, and a map. The detail for each area lives in a `CLAUDE.md` inside the directory it governs. Claude Code loads one of those only when it first reads a file in that directory, so **a session that starts at the repo root has not seen them: open the area's file (see "Where things are") before you plan or change anything there.** Keep the split: a rule that only matters in one directory goes in that directory's file, and this file stays under 25 KB.

**`docs/engineering-history.md` holds the evidence behind the rules in this file** — the measurements, incidents and abandoned approaches that produced them. Read it before changing a rule, or when one looks arbitrary. It covers the rules in the nested files too.

## Mission, vision, and values

**Mission:** To deepen the connection between fans and artists so appreciation turns into lasting support.

**Vision:** A world where more people support the arts and where more artists are sustainably supported.

**Values:** Unwavering respect for artists · Patience · Curiosity · Transparency

**Operating principles:** Artists first, supporters second · build for connection, not just transaction · solve from first principles, don't be afraid to be scrappy · no ego in the face of conflict.

These inform engineering trade-offs, not just marketing copy — when a decision pits fan convenience against artist payout or transparency, artists first wins.

## Architecture

- **Frontend**: React 19 SPA, React Router 7, Tailwind CSS v4, Vite 7, TypeScript. PWA-enabled (`vite-plugin-pwa`); most pages lazy-loaded in `apps/web/src/main.tsx`.
- **Backend**: Netlify Functions (serverless API, `api/functions/`, Node) + Edge Functions (SSR/SEO, `api/edge/`, Deno — see `deno.lock`).
- **Database**: Supabase (Postgres with RLS) — artist profiles, analytics, merge overrides, API keys, verification requests, saved/supported artists, public usernames, releases, collections, Bandcamp probe cache.
- **Enrichment**: MusicBrainz, Wikidata, Wikipedia, Discogs, Linktree, Bandcamp artist pages. **Caching / rate limiting**: Upstash Redis. **Monitoring**: Sentry (`apps/web/src/services/sentry.ts`, `api/lib/sentry.ts`). **Analytics**: GoatCounter + custom Supabase analytics. **Email**: Resend for transactional mail (`api/lib/resend.ts`, `notifications.ts`) — release alerts, claim decisions, and the welcome email new accounts get about 15 minutes after signing up (`welcome-email.ts`, from support@; the repo's one scheduled Netlify function, every 5 minutes, because a GitHub Actions cron can run hours late).
- **Integrations**: public REST API (v1), social post automation, ListenBrainz scrobbling (Mac app only; the backend has no ListenBrainz code).
- **Clients**: web app, universal Apple app (macOS menu bar + iOS, SwiftUI), browser extension (Chrome + Firefox, MV3). **Hosting**: Netlify.

## Where things are, and which file to read

Only the non-obvious parts; `ls` covers the rest.

| Working in | Read | It covers |
|---|---|---|
| `api/` (all of it) | `api/CLAUDE.md` | Folder roles, typecheck coverage, the platform registry and its copies, Bandcamp probing, artist bios |
| `api/functions/` — **the live backend** | `api/functions/CLAUDE.md` | `withSentry`, `db.ts`, search flow, the Redis budget, middleware, CORS, SSRF, server-side sign-in checks, claims, admin tools, the v1 API, release ingest, dedup and the sweep, collections, tips |
| `api/edge/` — Deno edge functions | `api/edge/CLAUDE.md` | Edge routes, who gets which renderer, the caching opt-in, `edgeEnv()`, release-page preview |
| `apps/web/` — the React SPA and its dev-only shim | `apps/web/CLAUDE.md` | Feature surfaces, account and artist menus, feature flags in the browser, sign-in UI, the widget, `dev:fast` |
| `apps/mac/` — the Apple app | `apps/mac/CLAUDE.md` | XcodeGen, Sparkle, its copies of shared logic |
| `apps/extension/` — the MV3 extension | `apps/extension/CLAUDE.md` | Its copies of shared logic, packaging |
| `scripts/`, `data/` | `scripts/CLAUDE.md` | Build order, which pushes deploy, social posts, the Dispatch archive, no digest |
| `supabase/` | `supabase/CLAUDE.md` | How migrations deploy, the dry run, backups, plan and provider decisions |

**`docs/`** — `engineering-history.md`, `specs/`, `postmortems/`, `openapi.yaml`. **`netlify.toml`** — edge routes, `/api/*` redirects, headers/CSP.

Some tasks cross directories. Open these before starting:

- **A platform** (name, payout, category, icon): `api/CLAUDE.md`, "Platform registry". Its hand-kept copies need the same change.
- **A merge of two results by artist name**: `api/functions/CLAUDE.md`, "Search flow". The Bandcamp-account check lives in three copies.
- **A new endpoint**: `api/functions/CLAUDE.md` (the `endpoint()` wrapper, Sentry wrapper, CORS shape, second-factor check, its test).
- **A feature flag, or a new way into a flagged feature**: `apps/web/CLAUDE.md`, "Feature flags: the server decides, everywhere".

**Removed on purpose.** Each of these was tried and taken out; read the note before proposing it again: hosting on Cloudflare Workers (below) · the Discord bot, search as a cataloguing trigger, release type as release identity, tips Phase 1 (`api/functions/CLAUDE.md`) · passkeys as a second step, the guides section (`apps/web/CLAUDE.md`) · a weekly digest in this repo, the Dispatch as RSS (`scripts/CLAUDE.md`).

## Commands

```bash
npm run dev        # Full stack: netlify dev :8888 — real functions, edge functions,
                   #   production Supabase data + auth. Use this by default (still production).
npm run dev:fast   # Vite only :5173 (no functions, no auth). CSS/layout only.
npm run verify     # THE CI GATE: typecheck + API + web unit tests (~45s)
npm run build      # Full build (see below) · npm run preview · npm run lint (advisory)

npm run test       # web + API · test:web · test:unit (CI) · test:api (CI) · test:watch
npm run test:integration   # live-API search accuracy; separate, not in CI
npm run typecheck          # api/ + scripts/ + apps/web (CI; the build runs it without scripts/)
npm run typecheck:api      # api/ — functions, tests, shared, lib, search (api/CLAUDE.md)
npm run typecheck:scripts  # scripts/, same strict settings
npm run typecheck:edge     # api/edge/ through `deno check` (needs Deno; CI runs it)

npm run generate:artists|generate:data|generate:social   # Wikidata list, artist JSON, posts
npm run sync:bandcamp-dates · backfill:artist-rows · backfill:locations
npm run dedupe:releases            # Apply dedup rules to the stored catalog (api/functions/CLAUDE.md)
npm run catalog:artist -- <slug>   # Catalogue pass for one artist
npm run ingest:try -- <artist>     # Dry-run Bandcamp ingest (api/functions/CLAUDE.md); ingest:mirlo too
npm run preview:release -- <bandcamp-slug-or-url>  # Release-page harness :8788 (api/edge/CLAUDE.md)
npm run sentry:sourcemaps · package:extension
npm run migrate:link|migrate:dry-run|migrate:list        # Supabase CLI, --linked
```

`npm run build` runs, in order: dispatch feed → changelog feed → sitemap → root `tsc -b` → `apps/web` `tsc -b` → `vite build`. Any failure blocks the deploy, so a type error can't ship. A generator that runs after `vite build` is never published; `scripts/CLAUDE.md`, "Build order", has the rule.

**The test suites are not part of the build** — they run in GitHub Actions (`ci.yml`), because Actions minutes are free here and Netlify builds are not. So **run `npm run verify` before considering work done**, and note that **a red CI run does not stop a deploy**: Netlify builds whatever lands on `main`, which is not branch-protected.

What the typechecks cover, and when to run `npm run typecheck:edge` yourself, is in `api/CLAUDE.md`, "Typecheck coverage".

## Branches and pull requests

Work on a branch and open a pull request; never commit straight to `main`.

**Check a pull request's state before pushing to its branch, every time** — including a fix Auto-fix asked for. Run `gh pr view <n> --json state` first; only `OPEN` takes the push. If it says `MERGED` or `CLOSED`, push nothing there: branch fresh from `origin/main` (`git checkout -b <name> origin/main`, since `main` is checked out in the primary worktree), bring the commits over with `git cherry-pick`, and open a new PR. PRs here are squash-merged, so a commit pushed to a merged PR's branch is never an ancestor of `main` and reaches nothing — yet the push succeeds, the closed PR shows nothing new, and the work looks shipped. The incident is in `docs/engineering-history.md`.

## Deployment

Pushes to `main` trigger Netlify builds (`npm run build`). Functions deploy from `api/functions/`, edge functions from `api/edge/`; edge routes, `/api/*` redirects and headers/CSP live in `netlify.toml`.

**Not every push deploys.** `netlify.toml`'s `ignore` setting runs `scripts/netlify-ignore-build.sh`, which cancels the build when a push touches only paths Netlify never publishes — `apps/mac/`, `apps/extension/`, `supabase/`, `docs/`, `.github/`, `README.md`, `CLAUDE.md`. A nested `CLAUDE.md` counts too, unless it sits under `apps/web/public/` or `data/`. The script's own rules (its inverted exit code, why `data/` and `scripts/` always deploy) are in `scripts/CLAUDE.md`, "Which pushes deploy".

**Deploy Previews are opt-in per push.** `[context.deploy-preview]` runs `scripts/netlify-ignore-preview.sh`, which cancels the preview unless the PR's head commit message contains `[preview]` — so by default a PR gets no preview URL and its Netlify checks don't run (configuration, not breakage). #451 turned them off because they ate the build allowance; add the marker only to the push you actually want to open on a phone or share. A preview runs the real functions against **production** Supabase, same as `npm run dev`. Without the marker, **`npm run dev` is the only way to exercise the real backend before merging.**

GitHub Actions: `ci.yml` (typecheck + both suites — the gate that used to live in the Netlify build — plus `deno check` on the edge functions as its own job) · `supabase-migrate.yml` · `schedule-social-posts.yml` (weekly, committed back) · `semantic-revert-check.yml` (runs `scripts/semantic-revert-check.py` to flag changes that quietly undo earlier fixes — take it seriously; bug loops in `docs/postmortems/UNS-100-bifurcation-retro.md`) · `upstash-keepalive.yml` · `recatalog-sweep.yml` (every 12h) · `db-backup.yml` (nightly encrypted backup to R2, see Database / migrations) · `mac-build.yml` (compiles the Apple app and runs XCTest on `apps/mac/` changes; never signs or uploads) · `weekly-analytics-recap.yml` (paused, manual dispatch only). ("Database / migrations" is in `supabase/CLAUDE.md`.)

## Local dev: the full stack, and the fast shim

**Use `npm run dev` — the real one — by default.** It is the *only* way to exercise the real backend before merging, because Deploy Previews are opt-in per push (see Deployment); treat a gap in it as a real gap.

**It reads and writes PRODUCTION Supabase.** `netlify dev` injects the live site's environment, so functions hold `SUPABASE_SERVICE_KEY` and bypass RLS as production does. Reads are free; **writes are real** — saving an artist, claiming a profile or changing settings mutates production rows, and `RESEND_API_KEY` / `BUTTONDOWN_API_KEY` mean notification paths can send real email. Cataloguing is the one thing that stays off; don't "fix" that.

`dev:fast` is for pure CSS/layout iteration. Anything touching data, auth, an API response, SEO markup or routing needs `npm run dev`. The side-by-side comparison is in `apps/web/CLAUDE.md`.

Four traps, all producing a *silently wrong* result rather than an error: one here, one about worktrees in `api/CLAUDE.md`, two for `dev:fast` in `apps/web/CLAUDE.md`.

- **The empty-value shadow.** A key present but blank in `.env` overrides the real value from the Netlify site settings, logged as `Ignored project settings env var: X`. **Delete a key from `.env` rather than leaving it blank**, and check the startup log's `Injected project settings env vars` list — a key you need belongs there, not in an `Ignored` line. Three blank keys are why local auth never worked until 2026-08-15.
- **In a worktree, `npm run dev` serves the main checkout's functions and edge functions** unless you pass `--functions`: `api/CLAUDE.md`, "Running `npm run dev` from a worktree". A worktree also needs `.netlify/state.json` and `.env` copied from the main checkout (both gitignored).

`npm run dev` rewrites `deno.lock`; `git checkout -- deno.lock` before committing, same habit as the generated feed XML.

## Testing

Vitest, in three places:

- `apps/web/tests/unit/` — component and pure-logic tests. Run in CI.
- `apps/web/tests/integration/` — search accuracy against live APIs (`tests/fixtures/expected-results.json`). Separate; not in CI.
- `api/functions/__tests__/` — function tests (cache behavior, probe cache coverage, XSS defense, the `me-*` endpoints). In CI via `npm run test:api`.

`npm run verify` runs the CI gate locally. `npm run lint` is *not* in it yet. The 2026-11-16 cleanup took ESLint from 90 errors to 14, all in `apps/web/src/` and all React Compiler rules: 13 `react-hooks/set-state-in-effect` and one `react-hooks/immutability` (`ArtistEditPage`). Fixing those changes when a component renders or what it holds in state, so each needs a look in a browser, not a mechanical edit. Until they're cleared lint stays advisory: run it after touching `apps/web`, don't add to the 14, and when it exits 0 add it to `verify`. Two habits keep the rest clean: a component file exports only components (helpers go in a `<Component>Utils.ts` beside it, like `ResultCardUtils.ts`; hooks in `src/hooks/`), and an `eslint-disable` goes on the one line it excuses, with the reason on that line.

The root `vitest.config.ts` covers both trees so `npx vitest` works from the repo root; `apps/web/vitest.config.ts` covers the web tree.

## Database changes

The schema is the migrations in `supabase/migrations/`; `supabase/CLAUDE.md` covers how they deploy, the dry run and backups. These rules apply wherever a change starts.

Changes ship as new files there (e.g. `20260726120000_bandcamp-slug-probes.sql`), and **filename order is what Supabase applies**. Don't edit historical migrations.

When adding a table or column: new migration, RLS policies included, `IF NOT EXISTS` / `DROP ... IF EXISTS` guards for idempotency, comments explaining the change. Server-only tables (like `bandcamp_slug_probes`) enable RLS with *no* policies — the service-role client bypasses RLS, anon gets nothing — and should say so in a comment so the missing policies don't read as an oversight.

**Applying a migration to production from an unmerged branch poisons every later migration.** `supabase db push` aborts *before applying anything* when production has a version missing locally, so one migration left on an unmerged branch silently blocks everybody's migrations on `main` — it happened, and took release alerts down for 30 hours. If you run the workflow by hand from a branch, merge it promptly and **check the workflow went green**; the failure is loud in Actions and invisible everywhere else.

## Cloudflare Workers: tried and removed (2026-10-23)

The whole site was ported to a Cloudflare Worker (#653, #663) and then removed, because Bandcamp
challenges every page request from a Worker: no Bandcamp discovery, card data or catalogue
(`docs/specs/bandcamp-from-workers.md`). **Unstream stays on Netlify's legacy plan; don't propose
moving to Workers.** If Netlify ends that plan, or Bandcamp starts challenging Netlify, follow
`docs/specs/hosting-contingency-plans.md`. It also says what carries over from the port, now in
git history. A few things from the port stay, because they hold on Netlify too:

- `edgeEnv()` and `CDN-Cache-Control`: `api/edge/CLAUDE.md`.
- A live Stripe key under `npm run dev` switches tips off: `api/functions/CLAUDE.md`, "Artist patronage (tips)".
- Netlify keeps secret-flagged env vars write-only: `supabase/CLAUDE.md`, "Plan and provider decisions".

Where the database is hosted, and the written plans for moving it or the app, are in `supabase/CLAUDE.md`, "Plan and provider decisions". Read it before proposing any hosting or provider change.

## Never cache uncertainty

The lesson behind a run of bug fixes (#317–#328); it applies to every cached lookup.

- Distinguish **"the upstream answered with nothing"** (cacheable) from **"the upstream didn't answer"** — timeout, network error, bot challenge, 5xx (never cacheable as a negative). The probe's `undecided` verdict exists so the cache can refuse it.
- `cacheGetOrFetch` (`api/functions/cache.ts`) takes a `shouldCache` predicate and an optional short `failureTtlSeconds`. Use them for anything whose failure mode looks like an empty result.
- Cache keys must not collide across inputs that behave differently — `query_norm` strips punctuation, but punctuation generates extra slug candidates, hence `probed_slugs`.
- A silent `200` with an empty parse is a failure. Report it to Sentry rather than letting it look like "this artist doesn't exist."

## Engineering principles

Default to **simple, boring code that a human can read once and understand.** The owner reviews at the product level, so the codebase has to stay legible to whoever (human or agent) touches it next. When in doubt, choose the obvious option over the clever one.

- **Boring beats clever.** Plain, explicit code over abstraction, metaprogramming or "smart" one-liners. No layers, generics or config flags for flexibility nobody asked for.
- **Match the surrounding code.** Follow the naming, structure and idioms already in the file, and reuse existing helpers (`middleware.ts`, `cache.ts`, `platform-registry.ts`, `apps/web/src/services/*`) instead of reinventing them.
- **Small, focused units.** See how `ResultCard*` and `Claim*Step` are split, and how pure search logic moved to `search-utils.ts` / `search-parsers.ts`. If a file grows a second responsibility, split it.
- **Name things for what they do,** with a short comment for non-obvious *why*; don't comment the obvious. Comments explaining *why* an approach was abandoned (blocked endpoints, removed allowlist hosts, cache-collision fixes) are load-bearing — keep them current instead of deleting them.
- **No dead weight.** No commented-out code, unused exports, speculative branches or TODOs without follow-through.
- **Scale through clarity, not premature optimization.** Straightforward version first; optimize only with a concrete reason (a real hot path, a measured cost), and note the trade-off.
- **Fail loudly.** Validate inputs at boundaries, surface errors to Sentry, avoid silent catches. A scraper returning an empty array on a bot challenge is a silent failure: report it.
- **Never cache uncertainty.** A failed lookup is not a negative result — the most repeated bug class in this codebase.
- **One route, one renderer.** If a URL is server-rendered by an edge function, it is not also client-rendered by the SPA. "Two renderers for one URL" causes back-button / bfcache breakage and bug loops where every fix partially reverts the last (`docs/postmortems/UNS-100-bifurcation-retro.md`, UNS-70/71/73/94/97/99/100). When you need both crawler HTML *and* React interactivity, decide per request: the edge function renders for crawlers and hands real browsers straight to the SPA (`context.next()` before any data fetch), so each request gets exactly one renderer and the SPA never "takes over" from a static response. `/u/:handle` and the artist pages are the reference; the release page is the other legal shape, pure SSR for everyone with nothing hydrating.
- **Respect other people's servers.** Check `robots.txt` before adding a scrape and honor it — several outages here were self-inflicted by scraping disallowed paths. Prefer documented APIs, directories and sitemaps; cache aggressively.

### Security practices

Treat security as part of "done," not a later pass. Flag anything you can't fully resolve rather than leaving it silent.

- **Validate and sanitize all external input** at the boundary — query params, bodies, URL params, webhook payloads. Escape anything interpolated into server-built HTML with `escapeHtml` from `api/shared/html.ts`, the one copy the edge functions, the functions and the shared fragments all import; `xss-defense.test.ts` tests it and fails if a private copy reappears. The test can't see whether a renderer *calls* it, so check every interpolation by eye and test the edge function's own render where you can.
- **SSRF protection is mandatory** for any code fetching an external URL. Add hosts to `ALLOWED_OUTBOUND_HOSTNAMES` and check with `isUrlHostnameAllowed()`; for a URL from a request, the database or scraped markup, use `safeFetch`. Never add a raw `fetch(userUrl)`.
- **Respect the CORS/auth model.** Admin and v1 endpoints use `buildCorsHeaders`: anonymous callers restricted to `unstream.stream`, API-key requests permissive because the key is the authorization. Endpoints that take a signed-in person's Bearer token use `buildAccountCorsHeaders`. Only read-only public data gets `buildPublicCorsHeaders` (`*`). An endpoint picks one with the `endpoint()` wrapper's `cors` option, and a signed-in endpoint can't pick the wildcard; never a hand-rolled header.
- **RLS on every table.** New tables/columns ship with policies in a migration. Server-only tables ship with RLS enabled, no policies, and a comment saying that's deliberate. Never rely on client-side checks for authorization.
- **`REVOKE ... FROM PUBLIC` is not enough for functions on Supabase.** Supabase's default privileges grant EXECUTE on every new `public` function *directly* to `anon` and `authenticated`, so a PUBLIC revoke still leaves both able to call it at `/rest/v1/rpc/<name>` — this left `rollup_app_events()` (which deletes rows) anon-callable for a few hours (found and fixed 2026-09-19 in `20260919140000_revoke-anon-function-execute.sql`). Revoke from `PUBLIC, anon, authenticated` and rely on the service role; every `rpc()` in the codebase runs through `getClient()` in `db/client.ts`. Vanilla-Postgres Docker validation cannot catch this class — only Supabase has those default privileges.
- **Every function sets its own `search_path`**, in its definition (`SET search_path = public, pg_temp`). Without one it resolves unqualified names through the caller's. `CREATE OR REPLACE FUNCTION` keeps only ownership and grants, so redefining a function without the clause silently drops a pin an earlier migration added (`20261109192616_pin_function_search_path.sql`).
- **No secrets in code or logs.** Don't log API keys, tokens, magic-link codes or personal data. API keys are stored hashed — keep it that way. Cache keys derived from user input hold normalized search terms, not PII.
- **Verify signed requests** where the pattern exists (e.g. the Stripe webhook's HMAC check). Don't bypass it for convenience.
- **Keep CSP and security headers intact** — don't loosen them in `netlify.toml` without a clear reason.
- **Least privilege.** Check admin/ownership before privileged actions (merges, verification, profile edits, username claims) on the server, not just in the UI.

## Working with the project owner

The owner is a highly experienced product manager with deep familiarity with web technologies, product strategy, UX and the alternative music platform ecosystem. He gives detailed product requirements, evaluates trade-offs, reviews UI/UX and navigates the codebase conceptually. He is not a software, security or infrastructure engineer. So:

- **Write production-ready code directly** rather than snippets to implement. Don't assume he can fill gaps, wire things up or debug build/runtime errors himself.
- **Handle security proactively** — CSP, RLS, input validation, SSRF, auth edge cases. Flag issues clearly rather than expecting them to be caught in review.
- **Manage infrastructure** — Netlify config, migrations, edge routing, env vars, deploys — and explain what changed and why.
- **Explain trade-offs in product terms**: user impact, maintenance burden, complexity.
- **Run tests and lint before considering work done.** Don't leave broken builds for him to debug.
