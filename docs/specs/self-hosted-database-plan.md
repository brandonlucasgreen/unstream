# Moving the database to a Hetzner VPS (auth stays on Supabase)

**Date:** 2026-09-26
**Status:** Decided: a 2 GB Hetzner box in Ashburn. Nothing is bought, built or changed yet.
**Why:** the free Nano instance is the ceiling: 0.5 GB shared between Postgres, PostgREST,
Auth and the pooler, and a disk that throttles after bursts. It wedged on 2026-09-19, and six
rounds of I/O work (`supabase-disk-io-investigation.md`) have been rationing around it. The
database itself is 98 MB.

## The short version

- **What moves:** Postgres and PostgREST (the REST layer `supabase-js` talks to), which are the
  parts that wedge. **What stays:** Supabase Auth on the hosted free project, Netlify functions and
  edge functions, Upstash (for now, see §9), and the apps.
- **No client changes, nobody logs out.** The web app, Mac app and extension only use Supabase for
  sign-in. Every table read and write already goes through Netlify functions with the service
  key, so the database never has to be reachable from a browser.
- **The code change is small.** A separate env var pair for data, about 20 call sites, shipped
  first as a no-op.
- **Cutover means setting two env vars and redeploying. Rollback means unsetting them.**
- **Cost:** about $25 a month, the same as Supabase Pro.

---

## 1. The decision, and what was ruled out

I couldn't reach Hetzner's site from the sandbox this was written in. The prices below are
third-party reports from September 2026, so **confirm them in the Hetzner console**.

| Option | RAM | ~Monthly | Disk I/O budget | Latency to Netlify functions | You run it? |
|---|---|---|---|---|---|
| Supabase free (today) | 0.5 GB shared | $0 | burst, then throttled | — | No |
| Supabase Pro (Micro) | 1 GB | $25 | burst, then throttled | unchanged | No |
| Supabase Pro + Small | 2 GB | ~$30 | burst, then throttled | unchanged | No |
| **Hetzner Ashburn, 2 vCPU / 2 GB (chosen)** | 2 GB | **~$20.50 + $4 backups** | **none** | ~10–15 ms | Yes |
| Hetzner Germany/Finland | 4 GB | ~€5.50–8 | none | ~90–110 ms per query | Yes |
| Mac Studio at home | 32 GB | ~$0 | none | depends on your line | Yes |

**Why Hetzner Ashburn, at about the same price as Supabase Pro:**
- **No disk I/O budget.** The 09-19 outage was a throttled disk, and every Supabase instance
  size up to Small still has that burst-then-throttle limit. Local fast disk has none.
- **Twice the RAM of Pro.** At 2 GB the whole 98 MB database lives in memory.
- **Room for more.** The same box can later take over Redis from Upstash (§9), whose monthly
  command cap is the other limit the codebase rations around.
- **Full Postgres control,** and the data sits on Hetzner rather than Supabase-on-AWS.

**What was ruled out:**
- **Hetzner EU:** every query would cross the Atlantic.
- **The Mac Studio:** FileVault blocks an unattended restart after a power cut, latency depends on
  your home line, and it would share a machine with personal data.
- **Supabase Pro:** still the fallback if running a server stops being worth it. Reversing this
  plan is the same two-env-var flip.

**Pricing notes.** Hetzner raised US prices twice in 2026 (April and June 15), renamed its shared
plans in June, and cut US included traffic to 1 TB a month. Traffic is irrelevant here, since
database responses are tiny. The latency figures assume Netlify's default functions region,
`us-east-2` (Ohio); check site settings → Functions → Region.

**Why 2 GB is enough:** Postgres gets 512 MB of dedicated cache for a 98 MB database, and the OS
page cache covers the rest. The whole stack (Postgres, PostgREST, Caddy, OS) fits in about
1.2 GB. If the database grows past about 1 GB, or Redis moves onto the box, rescale to 4 GB in
the Hetzner console. That takes a reboot of a minute or two, and your data stays put.

---

## 2. Shopping list

| # | Item | Choice | ~Cost | Notes |
|---|---|---|---|---|
| 1 | Hetzner Cloud account | — | $0 | New accounts can hit ID verification; sign up a few days early. |
| 2 | Server | Shared AMD, **2 vCPU / 2 GB RAM / 40 GB disk**, location **Ashburn (ash)**, Ubuntu 24.04 | ~$20.50 | This plan was sold as CPX11 before the June 2026 renaming; pick whatever the console now calls the 2 GB shared-AMD plan in Ashburn. Skip dedicated vCPU (CCX): CPU isn't the problem. **Tick "keep disk size" if you ever rescale**, so you can scale back down. |
| 3 | IPv4 address | Keep the default primary IPv4 | small line item, if any | Netlify's functions reach out over IPv4; an IPv6-only box is unreachable from them. |
| 4 | Hetzner Backups | Enable on the server | +20% (~$4) | 7 rolling daily snapshots. This is the *second* layer, not the backup plan (see #6). |
| 5 | Hetzner Cloud Firewall | Inbound TCP 80 + 443 only | $0 | Sits outside the server, so Docker can't punch holes in it (see §5). |
| 6 | Offsite backup bucket | Cloudflare R2 *or* Backblaze B2 | $0 | Both have 10 GB free; a compressed dump is tens of MB. Keeping it off Hetzner means one provider's bad day can't take both copies. |
| 7 | Tailscale | Personal (free) | $0 | SSH access, plus how GitHub Actions reaches Postgres to run migrations. No port 22 or 5432 open to the internet. |
| 8 | DNS record | `db.unstream.stream` → server IPv4 (A record) | $0 | Wherever `unstream.stream` DNS already lives. |
| 9 | Uptime monitor | UptimeRobot *or* Better Stack free tier | $0 | Pings `https://db.unstream.stream/health` and alerts your phone. |
| 10 | Cron heartbeats | Healthchecks.io free | $0 | Alerts when backups or the restore drill *stop* running. |
| 11 | Database GUI | DBeaver / pgAdmin (free), or TablePlus (paid) | $0 | Replaces the Supabase SQL editor for data queries, over Tailscale. |
| 12 | Encryption key for dumps | `age` keypair, private key in your password manager | $0 | Dumps contain emails (`artist_profiles`, `verification_requests`, `email_log`). |

**Total: about $25 a month**, pending the confirmed server price.

---

## 3. Target architecture

```
Web / Mac app / extension ──sign-in only──▶ Supabase Auth (hosted, free, unchanged)
                                                ▲ token checks (JWKS / getUser)
Netlify functions, edge functions, scripts ─────┘
        │
        │ HTTPS  https://db.unstream.stream/rest/v1/*   (service-role JWT)
        ▼
  ┌──────────── Hetzner VPS ────────────┐
  │ Caddy (TLS) ─▶ PostgREST ─▶ Postgres│──every 6h──▶ R2/B2 (encrypted pg_dump)
  └─────────────────────────────────────┘──daily────▶ Hetzner snapshots
        ▲
  laptop / GitHub Actions ──Tailscale──▶ SSH, psql, supabase db push
```

Why this shape:

- **`supabase-js` talks to `${url}/rest/v1/*`, which is PostgREST.** Serve PostgREST at that path
  and every `.from()` and `.rpc()` in the codebase works unchanged. Supabase's self-hosted Docker
  setup runs about a dozen containers (Kong, Studio, GoTrue, Realtime, Storage, analytics and
  more); Unstream needs two of them.
- **Use the `supabase/postgres` image, not stock Postgres.** It ships the roles (`service_role`,
  `authenticator`, `anon`, `authenticated`), the `auth.uid()` helpers that the RLS policies in 12
  migrations reference, and `pg_cron`, `pg_stat_statements` and `pg_trgm`. A schema dump restores
  without edits.
- **Caddy** handles TLS automatically in about ten lines of config.
- **Postgres never listens on a public interface.**

---

## 4. Code changes: ship first, as a no-op

Today one `SUPABASE_URL` serves both auth and data. Split them:

- **New env vars `DATA_API_URL` and `DATA_API_SERVICE_KEY`**, each falling back to
  `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` when unset. Merging changes nothing, and cutover is an
  env change.
- **Data call sites to switch:** `getClient()` in `api/functions/db.ts:32–39`,
  `api/functions/artist-directory.ts:68–75`, the three edge functions
  (`artist-page-static.ts:223`, `release-page.ts:148`, `u-handle.ts:70`), 14 scripts under
  `scripts/`, and the env block in `.github/workflows/schedule-social-posts.yml`.
- **Auth call sites stay on `SUPABASE_URL` + `SUPABASE_ANON_KEY`, unchanged:** `middleware.ts`
  (`getUser`, and the JWKS issuer check at :113–135), `me-password.ts`, `me-settings.ts`,
  `claim-artist.ts`, `artist-profile.ts`, `collection-art.ts`.
- **Two traps: data-client calls that are really Auth admin calls.** These must move to a
  hosted-auth service client:
  - `me-password.ts:97`: `getClient() ?? createClient(...)` → `auth.admin.updateUserById`.
  - `notifications.ts:115`: `client.auth.admin.getUserById`, in `resolveEmails`. That loop
    `continue`s on error, so pointing it at the VPS would **silently drop every release-alert
    email**. Fix the routing, and report errors there to Sentry while in the file.
- **Migration: drop the 8 foreign keys to `auth.users`.** They're on `usernames`,
  `saved_artists`, `release_feed_tokens`, `notification_preferences`, `verification_requests`,
  `bandcamp_connections`, `collection_items` and `listening_signals`. The VPS has no users table
  to point them at, and the restore fails on them. Apply this on hosted *before* cutover; it's
  harmless there. **What it costs:** deleting a user in the Supabase dashboard no longer cascades
  their rows. There's no self-serve account deletion today, so ship a small
  `scripts/delete-user-data.ts` with that PR for the rare manual case.
- **`supabase-migrate.yml`:** replace `supabase link` / `db push --linked` with the Tailscale
  GitHub Action plus `supabase db push --db-url postgresql://…@<tailscale-host>:5432/postgres`.
  Store the URL as a secret.
- **`infra/vps/` in the repo:** `docker-compose.yml`, `Caddyfile`, Postgres config overrides,
  the backup and restore-drill scripts. Secrets live in a `.env` on the server, never committed.
  Add `infra/` to the skip list in `scripts/netlify-ignore-build.sh`, since nothing there reaches
  the built site.
- `npm run verify` green, with tests covering the fallback and asserting that Auth admin calls
  use the auth client.

---

## 5. Phase 1: build the server (a weekend)

1. **Create the server:** Ubuntu 24.04, Ashburn, your SSH key, and the Cloud Firewall from §2 #5
   attached.
2. **Base setup:** `unattended-upgrades`, Tailscale (`tailscale up --ssh`), password SSH off,
   Docker Engine + compose plugin. **Docker trap:** a published container port bypasses `ufw`.
   So Postgres publishes nothing (or binds to the Tailscale IP only), and the Hetzner firewall,
   which sits outside the VM, is the real perimeter.
3. **Containers** (`infra/vps/docker-compose.yml`, images pinned to exact versions):
   - `db`: `supabase/postgres`, **same major version as hosted** (run `SELECT version();` on
     hosted first), on a named volume.
   - `rest`: `postgrest/postgrest`, matching hosted's version (Dashboard → Settings →
     Infrastructure). Settings:
     - `PGRST_DB_SCHEMAS=public`
     - `PGRST_JWT_SECRET=<new secret>`
     - **no `PGRST_DB_ANON_ROLE`**, so requests without a valid key are refused outright
     - `PGRST_OPENAPI_MODE=disabled`, so the schema isn't published
     - `PGRST_ADMIN_SERVER_PORT=3001`
     - `PGRST_DB_POOL=10`
   - `caddy`: `db.unstream.stream` → `/rest/v1/*` strip-prefix proxied to `rest:3000`;
     `/health` → `rest:3001/ready` (200 only when PostgREST can reach Postgres); everything else
     404.
4. **Keys:** generate a fresh 64-character JWT secret and mint one long-lived `service_role` JWT
   from it. That token is `DATA_API_SERVICE_KEY`. **Don't reuse hosted's keys.** No anon key is
   needed at all.
5. **Postgres settings for 2 GB:**
   - `shared_buffers=512MB`
   - `effective_cache_size=1280MB`
   - `work_mem=8MB`
   - `maintenance_work_mem=128MB`
   - `max_connections=30` (PostgREST's pool of 10, pg_cron, and room for admin sessions)
   - `pg_stat_statements` on
   - `cron.database_name=postgres`

   Also give every container a memory limit in the compose file (Postgres ~900 MB, PostgREST
   ~200 MB, Caddy ~100 MB), so one runaway process can't starve the others.
6. **Swap:** add a 2 GB swap file with `vm.swappiness=10`. Hetzner images ship without swap. On a
   2 GB box, swap is what turns a memory spike into a slow minute instead of the kernel killing
   Postgres. If the swap-use graph is ever more than flat, that's the signal to rescale to 4 GB.
7. **Backups:** a cron job every 6 hours runs `pg_dump -Fc`, encrypts with `age`, uploads with
   `rclone` to R2/B2, then pings Healthchecks. A bucket lifecycle rule keeps 14 days of 6-hourly
   dumps plus 12 weeklies. Enable Hetzner Backups too. Worst-case data loss is 6 hours; add WAL
   archiving (wal-g) later only if that turns out to matter.
8. **Restore drill:** a monthly cron pulls the latest dump, restores it into a throwaway
   container, checks row counts against live, and pings Healthchecks. **A backup nobody has
   restored is a hope, not a backup.**
9. **Monitoring:**
   - UptimeRobot on `/health`, every 1–5 minutes.
   - Healthchecks on the backup job and the drill.
   - A daily check that pings Healthchecks only while disk use is under 80% *and* swap use is
     under 25%, so silence means
     trouble.

---

## 6. Phase 2: rehearse (a few evenings)

1. **Record from hosted:** Postgres and PostgREST versions, the pg_cron jobs
   (`SELECT jobname, schedule, command FROM cron.job;`), and row counts per table.
2. **Dump from hosted** through the session pooler connection string (IPv4):
   `pg_dump -Fc --no-owner --schema=public --schema=supabase_migrations`. Keep privileges.
   `supabase_migrations` carries the applied-migration history, so `db push` knows where it is.
3. **Restore on the VPS.** Recreate the pg_cron jobs from step 1.
4. **Verify:**
   - Row counts match.
   - `supabase db push --db-url … --dry-run` reports **nothing to apply**, which proves the
     migration history carried over.
   - The privilege intent of `20260919140000_revoke-anon-function-execute.sql` survived.
   - The round 6 measurement pack runs.
5. **Exercise it:** put `DATA_API_URL` / `DATA_API_SERVICE_KEY` in your local `.env` (a
   non-blank `.env` value overrides the Netlify-injected one, which is exactly what you want
   here) and run `npm run dev`. Walk through: search, an artist page, a release page, `/u/:handle`,
   sign in and save an artist (auth on hosted, write lands on the VPS), settings, admin merge,
   `npm run ingest:try`.
6. **Latency:** with the free Globalping CLI, compare round-trip time to `db.unstream.stream`
   and to the hosted Supabase host from an Ohio / AWS `us-east-2` probe. If the VPS isn't within
   ~10 ms of hosted, find out why before cutover.
7. Throw the rehearsal data away. It gets replaced at cutover.

---

## 7. Phase 3: cutover (about an hour)

**Before:**
- The §4 code change is deployed.
- The FK migration has landed on hosted and its workflow went green.
- **No migration PRs merge from the day before until step 7.**
- Pick the lowest-traffic hour from analytics.

1. **Stop background writers.** Disable the `recatalog-sweep` workflow, delete
   `RELEASE_CATALOG_ENABLED` in Netlify, and note the time as **T0**.
2. **Final dump from hosted, restore onto a clean VPS database.** About 5 minutes at 98 MB.
   Recreate the cron jobs and check row counts.
3. **Netlify:** set `DATA_API_URL` and `DATA_API_SERVICE_KEY` for all scopes, including runtime
   so the edge functions get them, then **trigger a deploy**; env changes only apply to a new
   deploy. Update the GitHub secrets used by `schedule-social-posts.yml`.
4. **Smoke test production:**
   - search
   - an artist page nobody has hit today, so it isn't served from CDN cache
   - sign in
   - save and unsave an artist
   - change a setting
5. **Catch up stragglers.** Copy anything written to hosted between T0 and the deploy from the
   user tables (`saved_artists`, `usernames`, `notification_preferences`, `collection_items`,
   `verification_requests`, `artist_profiles`), using `created_at` / `updated_at` where the table
   has them. At current traffic, expect zero to a handful of rows. A few minutes of analytics
   rows are an accepted loss.
6. **Restart background writers:** restore `RELEASE_CATALOG_ENABLED` and re-enable the sweep.
7. **Merge the `supabase-migrate.yml` switch.** From here, migrations target the VPS.
8. Watch Sentry and the uptime monitor for 24 hours.

**Rollback (for two weeks):** unset the two env vars and redeploy, and everything is back on
hosted. Writes made since cutover exist only on the VPS, so run the step 5 catch-up in reverse.

**Closing out, after two weeks with no rollback:**
1. Archive a final dump of hosted's `public` schema to the bucket.
2. **Drop the data tables on hosted by hand**, leaving auth untouched.
3. **Remove the env fallback** so `DATA_API_*` becomes required.

Without steps 2 and 3, a script or environment missing the new vars would quietly read stale
data from hosted instead of failing.

---

## 8. Phase 4: use the headroom, one dial at a time

The sweep's demand gate, the frozen catalogues and the refresh cadence were all set against a
0.5 GB disk budget. Revisit them **one at a time, measuring load between changes**, and update
the matching CLAUDE.md rationale with each. CLAUDE.md's "don't reintroduce search as a catalogue
trigger" stays in force until someone deliberately re-measures and rewrites it.

**CLAUDE.md updates:**
- **Architecture → Database:** VPS for data, hosted Supabase for auth.
- **Database / migrations:** now `db push` over Tailscale.
- **Local dev:** `npm run dev` still hits production data, now on the VPS.
- **New ops section:** where the server is, backups, how to restore, upgrade policy.
- **`docs/engineering-history.md`:** the move and why.

---

## 9. Later, optional: move Redis off Upstash onto the box

Not part of the migration. Do it only if Upstash's monthly command cap becomes a problem again,
and only after the database has run cleanly for a month.

- **No code change if it goes through a REST proxy.** The codebase uses `@upstash/redis` and
  `@upstash/ratelimit`, which speak Upstash's REST protocol, not plain Redis. Run Redis alongside
  an Upstash-compatible proxy such as `serverless-redis-http`, then change the two Upstash env
  vars. Opening a plain Redis connection on every function invocation would be slower.
- **Verify in rehearsal that `@upstash/ratelimit`'s Lua scripts work through the proxy.** The
  proxy is the bit to prove, not Redis itself.
- **Memory.** Cap Redis at 256 MB. The cache and dedup writes set TTLs (`cache.ts:92`,
  `ratelimit.ts:495`), so use `volatile-lru` eviction, after confirming nothing else writes keys
  without one. If Redis and Postgres together push swap above flat, rescale to 4 GB.
- **What it buys:** CLAUDE.md's four Redis rules exist because of the command budget. With no
  budget they become good hygiene rather than survival. Keep them anyway; they're also latency
  wins.

---

## 10. What you're signing up for

| Supabase did this | Now it's… |
|---|---|
| Patching OS and Postgres | `unattended-upgrades` for the OS; pinned images bumped quarterly, rehearsed against a restored dump first. Postgres major upgrades are a dump/restore into a new container. |
| Backups | §5.7. The monthly drill tells you they work. |
| Noticing it's down | UptimeRobot pages you. The usual fix is a reboot from the Hetzner console or phone app. |
| Disk, memory | The disk-and-swap heartbeat, plus Hetzner's graphs. Outgrowing 2 GB is a console rescale, not a migration. |
| Security perimeter | The Hetzner firewall, key-only SSH over Tailscale, no public Postgres, no anon role, OpenAPI disabled. **Rotating the JWT secret** means minting a new service key, updating Netlify, then swapping PostgREST's secret: a minute of failed requests unless you stage it. |

Expect about 30 minutes a month when nothing's wrong.

---

## 11. Risks and open questions

- **Hetzner's US price.** §1 is third-party data; confirm it before §2.
- **VPS down means deploys fail.** `scripts/generate-sitemap.ts` reads the database during
  `npm run build`, and a build failure blocks the deploy. Same as today with Supabase, but now
  it's your box.
- **Hosted auth on the free Nano.** With data gone its load is tiny, so a wedge is unlikely, and
  if one happens only sign-in breaks; search and public pages keep working. Supabase pauses
  inactive free projects. Clients refreshing tokens should keep it active, but a weekly ping job
  (like `upstash-keepalive.yml`) is cheap insurance.
- **2 GB is a floor, not a ceiling.** Watch swap, not RAM: Linux fills free RAM with page cache,
  so "memory used" graphs always look full. Rescaling is a console click and a short reboot.
- **Netlify functions region.** The latency numbers assume `us-east-2`. Confirm in site settings.
- **Version pairing.** A PostgREST major version that differs from hosted's could change edge
  behaviour `supabase-js` relies on (count headers, upsert conflict handling). Match it, and let
  the rehearsal catch the rest.
