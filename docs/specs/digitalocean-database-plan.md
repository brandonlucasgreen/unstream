# Moving the database to DigitalOcean (auth stays on Supabase)

**Date:** 2026-09-26
**Status:** Decided: DigitalOcean Managed PostgreSQL, with PostgREST on App Platform. Nothing is
set up or changed yet.
**Why:** the free Nano instance is the ceiling: 0.5 GB shared between Postgres, PostgREST,
Auth and the pooler, and a disk that throttles after bursts. It wedged on 2026-09-19, and six
rounds of I/O work (`supabase-disk-io-investigation.md`) have been rationing around it. The
database itself is 98 MB.

## The short version

- **What moves:** Postgres goes to DigitalOcean Managed PostgreSQL. PostgREST, the REST layer
  `supabase-js` talks to, goes to a container on DigitalOcean App Platform. **What stays:**
  Supabase Auth on the hosted free project, Netlify functions and edge functions, Upstash, and the
  apps.
- **No servers to maintain.** DigitalOcean patches Postgres and takes the backups. App Platform
  runs the container. The only thing we version is the PostgREST image.
- **Agents can run all of it.** Everything here can be driven by `doctl` (DigitalOcean's CLI),
  its API, or DigitalOcean's official MCP server, the same way Supabase's CLI works today.
- **No client changes, nobody logs out.** The web app, Mac app and extension only use Supabase for
  sign-in. Every table read and write already goes through Netlify functions with the service
  key.
- **The code change is small.** A separate env var pair for data, about 20 call sites, shipped
  first as a no-op.
- **Cutover means setting two env vars and redeploying. Rollback means unsetting them.**
- **Cost:** about $20 a month.

---

## 1. The decision

| | Supabase free (today) | Supabase Pro | **DigitalOcean (chosen)** |
|---|---|---|---|
| Monthly | $0 | $25 | **~$20** ($15 database + $5 container) |
| Postgres RAM | 0.5 GB, shared with PostgREST, Auth and the pooler | 1 GB, shared the same way | **1 GB for Postgres alone** |
| Disk I/O | burst, then throttled | burst, then throttled | **flat, included** |
| Runs on | AWS | AWS | DigitalOcean's own infrastructure |
| Backups | none you can download | daily | daily, plus restore to any point in the last 7 days |
| Agent-manageable | CLI, API | CLI, API | `doctl`, API, official MCP server |
| Company | VC-funded | VC-funded | public (NYSE: DOCN), running since 2011 |

**What was ruled out:**
- **A self-run VPS** (Hetzner, netcup, InterServer and others): cheap, but you become the
  database admin, and none of them fits your values much better than DigitalOcean.
- **Hetzner specifically:** its US servers are only sold through the Cloud Console, and it
  requires ID verification first.
- **The Mac Studio:** FileVault blocks an unattended restart after a power cut, and the machine
  holds personal data.
- **Supabase Pro** stays the fallback. Reversing this plan is the same two-env-var flip.

**Region:** NYC3 for both the database and the container. It's roughly 10–15 ms from Netlify's
default functions region, `us-east-2` (Ohio). Confirm the region in Netlify's site settings →
Functions.

**Why 1 GB is enough:** the database is 98 MB, and unlike Supabase, that 1 GB isn't shared with
anything else. If it ever isn't enough, resizing is one command:
`doctl databases resize <id> --size db-s-1vcpu-2gb`. That's about $30, after a short failover.

Prices are from DigitalOcean's pricing pages and third-party write-ups, September 2026; the
control panel shows the real figure before you confirm.

---

## 2. What you set up, and what an agent sets up

**You (about 20 minutes, needs your identity or card):**

| # | Item | Notes |
|---|---|---|
| 1 | DigitalOcean account | Card on file. Turn on two-factor auth. |
| 2 | A **scoped API token** for agents | Control panel → API → Tokens → custom scopes. Give it read plus create/update on databases, apps and monitoring, and **no delete**, so no agent can drop the database. Store it as `DIGITALOCEAN_ACCESS_TOKEN` in GitHub secrets and wherever agents run. |
| 3 | DNS record `db.unstream.stream` | A CNAME to the App Platform URL, wherever `unstream.stream` DNS lives. App Platform issues the TLS certificate itself. |
| 4 | Cloudflare R2 *or* Backblaze B2 bucket (free tier) | For the weekly offsite copy (§5.6). |
| 5 | Uptime monitor (UptimeRobot or Better Stack, free) | Watches `/api/health/db` (§4) and alerts your phone. |

**An agent, with the token (§5):** the database cluster, roles, the App Platform app, firewall
rules, alerts, the rehearsal, and the code changes.

| Item | ~Monthly |
|---|---|
| Managed PostgreSQL, 1 vCPU / 1 GB / 10 GB disk, single node, NYC3 | $15 |
| App Platform service, the $5 shared-CPU 512 MB size | $5 |
| R2 or B2, uptime monitor | $0 |
| **Total** | **~$20** |

Deliberately not bought: a standby node (+$15). It gives automatic failover, but a single node
with point-in-time restore is the right size for a 98 MB database. Add one later with
`doctl databases resize <id> --num-nodes 2` if downtime starts to matter more than $15.

---

## 3. Target architecture

```
Web / Mac app / extension ──sign-in only──▶ Supabase Auth (hosted, free, unchanged)
                                                ▲ token checks (JWKS / getUser)
Netlify functions, edge functions, scripts ─────┘
        │
        │ HTTPS  https://db.unstream.stream/rest/v1/*   (service-role JWT)
        ▼
  DigitalOcean App Platform: PostgREST container (NYC)
        │  database firewall: only this app, plus a temporary IP rule for a CI job
        ▼
  DigitalOcean Managed PostgreSQL (NYC3) ── daily backups + 7-day point-in-time restore
        │
        └── weekly encrypted pg_dump ──▶ R2 / B2 (offsite, from a GitHub Action)
```

Why this shape:

- **`supabase-js` talks to `${url}/rest/v1/*`, which is PostgREST.** Serve PostgREST at that path
  and every `.from()` and `.rpc()` in the codebase works unchanged. App Platform strips a route's
  path prefix by default, so routing `/rest/v1` to the container needs no proxy in front.
- **The database firewall ("trusted sources") admits only the App Platform app.** Nothing else
  can reach Postgres, including you, until a rule is added deliberately.
- **Why not connect Netlify functions straight to Postgres:** it would mean rewriting every query
  off `supabase-js` and managing connections from serverless functions. Keeping PostgREST keeps
  the code as it is.

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
    `continue`s on error, so pointing it at DigitalOcean would **silently drop every
    release-alert email**. Fix the routing, and report errors there to Sentry while in the file.
- **Migration: drop the 8 foreign keys to `auth.users`.** They're on `usernames`,
  `saved_artists`, `release_feed_tokens`, `notification_preferences`, `verification_requests`,
  `bandcamp_connections`, `collection_items` and `listening_signals`. DigitalOcean has no users
  table to point them at. Apply this on hosted *before* cutover; it's harmless there. **What it
  costs:** deleting a user in the Supabase dashboard no longer cascades their rows. There's no
  self-serve account deletion today, so ship a small `scripts/delete-user-data.ts` with that PR
  for the rare manual case.
- **`/api/health/db`:** a small function that makes one trivial read through the data client and
  returns 200 or 503. It tests the whole path the site depends on (Netlify → PostgREST →
  Postgres), which a check on PostgREST alone wouldn't. Put it behind the `lenient` limiter:
  that's one Redis command per check, about 4,300 a month at a 10-minute interval, under 1% of the
  Upstash budget.
- **`supabase-migrate.yml`:** replace `supabase link` / `db push --linked` with the following,
  so the database is only reachable from CI for the length of the job:
  1. Install `doctl`.
  2. Add the runner's IP to the database firewall.
  3. Run `supabase db push --db-url "$DATA_DB_URL"`.
  4. Remove the rule, in an `always()` step so a failed push still closes it.
- **`db-offsite-backup.yml` (weekly):** the same firewall open/close pattern, around
  `pg_dump -Fc`, `age` encryption and an `rclone` upload to R2/B2.
- **`infra/digitalocean/`:** the App Platform spec (`app.yaml`), the role/helper SQL from §5.3,
  and the `pg_restore` exclusion list from §6. Add `infra/` to the skip list in
  `scripts/netlify-ignore-build.sh`, since nothing there reaches the built site.
- `npm run verify` green, with tests covering the fallback and asserting that Auth admin calls
  use the auth client.

---

## 5. Phase 1: set up DigitalOcean (about an hour, agent-run)

1. **Create the database cluster.** Pick **the same Postgres major version as hosted** (run
   `SELECT version();` on hosted first):
   `doctl databases create unstream-db --engine pg --version <major> --region nyc3 --size db-s-1vcpu-1gb --num-nodes 1`
2. **Set the maintenance window** to a low-traffic hour
   (`doctl databases maintenance-window update`). DigitalOcean applies minor updates then.
3. **Recreate the pieces of Supabase the schema expects.** Keep this as one SQL file in
   `infra/digitalocean/`:
   - **Roles:** `anon`, `authenticated` and `service_role` (no login), and `authenticator`
     (login, `NOINHERIT`, a generated password), granted all three.
   - **`auth.uid()`, `auth.role()` and `auth.jwt()`** in an `auth` schema, reading
     `request.jwt.claims` the way Supabase defines them. RLS policies in 12 migrations reference
     them, so the restore fails without them. With the service role they're never actually
     evaluated.
   - **`service_role` must bypass RLS**, as it does on Supabase. Grant it `BYPASSRLS` if
     DigitalOcean's `doadmin` user is allowed to. **If not**, make `service_role` the owner of
     the `public` tables instead: table owners bypass RLS, and no migration uses
     `FORCE ROW LEVEL SECURITY`. This is the first thing the rehearsal settles.
   - **Extensions:** `pg_cron`, `pg_stat_statements` and `pg_trgm`, each in **the same schema
     it lives in on hosted** (§6.1). All three are on DigitalOcean's supported list.
4. **Keys:** generate a fresh 64-character JWT secret and mint one long-lived `service_role` JWT
   from it. That token is `DATA_API_SERVICE_KEY`. **Don't reuse hosted's keys.** No anon key is
   needed at all.
5. **Deploy PostgREST:** `doctl apps create --spec infra/digitalocean/app.yaml`. The spec's shape:

   ```yaml
   name: unstream-rest
   region: nyc
   services:
     - name: postgrest
       image:
         registry_type: DOCKER_HUB
         registry: postgrest
         repository: postgrest
         tag: <exact version, matching hosted's PostgREST major>
       instance_size_slug: <the $5 shared 512 MB size>
       instance_count: 1
       http_port: 3000
       routes:
         - path: /rest/v1        # prefix is stripped before it reaches PostgREST
       health_check:
         http_path: /ready       # PostgREST's admin port: 200 only when it can reach Postgres
         port: 3001
       envs:
         - { key: PGRST_DB_URI, type: SECRET }     # authenticator@…, sslmode=require
         - { key: PGRST_JWT_SECRET, type: SECRET }
         - { key: PGRST_DB_SCHEMAS, value: public }
         - { key: PGRST_OPENAPI_MODE, value: disabled }   # don't publish the schema
         - { key: PGRST_ADMIN_SERVER_PORT, value: "3001" }
         - { key: PGRST_DB_POOL, value: "10" }
         # no PGRST_DB_ANON_ROLE, so requests without a valid key are refused outright
   domains:
     - domain: db.unstream.stream
       type: PRIMARY
   ```

   Check field names against the current App Platform spec reference when writing the real file.
6. **Lock the firewall:** `doctl databases firewalls append <db-id> --rule app:<app-id>`. That
   one rule is the whole allowlist.
7. **Alerts:** DigitalOcean monitoring alert policies on the cluster's CPU, memory and disk (over
   80%), sent to your email. The uptime monitor on `/api/health/db` covers "it's down".
8. **Connections:** the 1 GB plan allows roughly two dozen. PostgREST's pool of 10, plus pg_cron
   and an occasional admin session, fits. Check with `SHOW max_connections;`.

---

## 6. Phase 2: rehearse (a few evenings)

1. **Record from hosted:**
   - Postgres and PostgREST versions.
   - Which schema each extension lives in:
     `SELECT extname, extnamespace::regnamespace FROM pg_extension;`
   - The pg_cron jobs: `SELECT jobname, schedule, command FROM cron.job;`
   - Row counts per table.
2. **Dump from hosted** through the session pooler connection string:
   `pg_dump -Fc --no-owner --schema=public --schema=supabase_migrations`.
   `supabase_migrations` carries the applied-migration history, so `db push` knows where it is.
3. **Restore into DigitalOcean** from a machine temporarily allowed through the firewall.
   - Restore into the database pg_cron is configured for; that's `defaultdb` unless DigitalOcean
     says otherwise.
   - Expect a few errors on statements that name Supabase-internal roles (`supabase_admin`,
     `postgres` default privileges). Exclude those with a restore list (`pg_restore -l` → edit →
     `pg_restore -L`), and commit that list to `infra/digitalocean/` so the cutover restore is
     identical.
   - Recreate the pg_cron jobs.
4. **Verify:**
   - Row counts match.
   - `supabase db push --db-url … --dry-run` reports **nothing to apply**, which proves the
     migration history carried over.
   - `service_role` can read and write every table (the §5.3 RLS question), and
     anon/authenticated can't execute the functions
     `20260919140000_revoke-anon-function-execute.sql` locked down.
   - The round 6 measurement pack runs.
5. **Exercise it:** put `DATA_API_URL` / `DATA_API_SERVICE_KEY` in your local `.env` (a
   non-blank `.env` value overrides the Netlify-injected one, which is exactly what you want
   here) and run `npm run dev`. Walk through: search, an artist page, a release page,
   `/u/:handle`, sign in and save an artist (auth on hosted, write lands on DigitalOcean),
   settings, admin merge, `npm run ingest:try`.
6. **Latency:** with the free Globalping CLI, compare round-trip time to `db.unstream.stream`
   and to the hosted Supabase host from an Ohio / AWS `us-east-2` probe. If DigitalOcean is more
   than ~10 ms slower, find out why before cutover.
7. **Remove the temporary firewall rule.** Leave the cluster running; the cutover restore
   replaces its data.

---

## 7. Phase 3: cutover (about an hour)

**Before:**
- The §4 code change is deployed.
- The FK migration has landed on hosted and its workflow went green.
- **No migration PRs merge from the day before until step 7.**
- Pick the lowest-traffic hour from analytics.

1. **Stop background writers.** Disable the `recatalog-sweep` workflow, delete
   `RELEASE_CATALOG_ENABLED` in Netlify, and note the time as **T0**.
2. **Final dump from hosted, restore into a clean database** with the same restore list.
   About 5 minutes at 98 MB. Recreate the cron jobs and check row counts.
3. **Netlify:** set `DATA_API_URL=https://db.unstream.stream` and `DATA_API_SERVICE_KEY` for all
   scopes, including runtime so the edge functions get them, then **trigger a deploy**; env
   changes only apply to a new deploy. Update the GitHub secrets used by
   `schedule-social-posts.yml`.
4. **Smoke test production:**
   - search
   - an artist page nobody has hit today, so it isn't served from CDN cache
   - sign in
   - save and unsave an artist
   - change a setting
   - `/api/health/db` returns 200
5. **Catch up stragglers.** Copy anything written to hosted between T0 and the deploy from the
   user tables (`saved_artists`, `usernames`, `notification_preferences`, `collection_items`,
   `verification_requests`, `artist_profiles`), using `created_at` / `updated_at` where the table
   has them. At current traffic, expect zero to a handful of rows. A few minutes of analytics
   rows are an accepted loss.
6. **Restart background writers:** restore `RELEASE_CATALOG_ENABLED` and re-enable the sweep.
7. **Merge the `supabase-migrate.yml` switch.** From here, migrations target DigitalOcean.
8. Watch Sentry, the uptime monitor and the DigitalOcean graphs for 24 hours.

**Rollback (for two weeks):** unset the two env vars and redeploy, and everything is back on
hosted. Writes made since cutover exist only on DigitalOcean, so run the step 5 catch-up in
reverse.

**Closing out, after two weeks with no rollback:**
1. Archive a final dump of hosted's `public` schema to the bucket.
2. **Drop the data tables on hosted by hand**, leaving auth untouched.
3. **Remove the env fallback** so `DATA_API_*` becomes required.

Without steps 2 and 3, a script or environment missing the new vars would quietly read stale
data from hosted instead of failing.

---

## 8. Phase 4: use the headroom, one dial at a time

The sweep's demand gate, the frozen catalogues and the refresh cadence were all set against a
0.5 GB shared disk budget. Revisit them **one at a time, watching the DigitalOcean graphs between
changes**, and update the matching CLAUDE.md rationale with each. CLAUDE.md's "don't reintroduce
search as a catalogue trigger" stays in force until someone deliberately re-measures and rewrites
it.

**CLAUDE.md updates:**
- **Architecture → Database:** DigitalOcean for data, hosted Supabase for auth.
- **Database / migrations:** `db push` through the temporary firewall rule.
- **Local dev:** `npm run dev` still hits production data, now on DigitalOcean.
- **New ops section:** the cluster, the app, the token scopes, backups, how to restore.
- **`docs/engineering-history.md`:** the move and why.

Upstash stays. DigitalOcean's managed cache doesn't speak Upstash's REST protocol, which the
codebase's Redis clients depend on, so moving Redis isn't worth doing here.

---

## 9. What you're signing up for

| Concern | Who handles it |
|---|---|
| Postgres patching | DigitalOcean, in the maintenance window. Major version upgrades are a `doctl` command, run against a rehearsal fork first (`doctl databases fork`). |
| Backups | DigitalOcean: daily, plus point-in-time restore for 7 days. Plus the weekly offsite copy, so an account-level problem can't take every copy. |
| Restoring | `doctl databases fork` restores a point in time into a new cluster, without touching the live one. Practice it once during the rehearsal. |
| PostgREST | Bump the pinned image tag a few times a year, after trying it on a local `npm run dev`. |
| Noticing it's down | The uptime monitor on `/api/health/db`, plus DigitalOcean's alerts. |
| Security | The database firewall admits only the app. No anon role, OpenAPI disabled, a scoped agent token with no delete permission. **Rotating the JWT secret** means minting a new service key, updating Netlify, then updating the app's secret: a minute of failed requests unless you stage it. |

Expect a few minutes a month when nothing's wrong, about the same as Supabase.

---

## 10. Risks and open questions

- **`BYPASSRLS` on DigitalOcean.** Whether `doadmin` can grant it decides between the two
  approaches in §5.3. Both work; the rehearsal picks one.
- **Supabase-internal statements in the dump.** Handled by the restore list, which is built once
  in rehearsal and reused at cutover.
- **One PostgREST instance.** App Platform deploys new containers before retiring old ones, but
  with a single instance, confirm during rehearsal that a redeploy doesn't drop requests. If it
  does, `instance_count: 2` costs another $5.
- **The database is down, so deploys fail.** `scripts/generate-sitemap.ts` reads the database
  during `npm run build`, and a build failure blocks the deploy. Same as today with Supabase.
- **Hosted auth on the free Nano.** With data gone its load is tiny, so a wedge is unlikely, and
  if one happens only sign-in breaks; search and public pages keep working. Supabase pauses
  inactive free projects. Clients refreshing tokens should keep it active, but a weekly ping job
  (like `upstash-keepalive.yml`) is cheap insurance.
- **Netlify functions region.** The latency numbers assume `us-east-2`. Confirm in site settings.
- **Version pairing.** A PostgREST major version that differs from hosted's could change edge
  behaviour `supabase-js` relies on (count headers, upsert conflict handling). Match it, and let
  the rehearsal catch the rest.
