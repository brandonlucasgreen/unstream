# supabase/ — the database

**`supabase/`** — `migrations/` is the schema (see "Database / migrations").

Read this with the root `CLAUDE.md`. Its "Database changes" section holds the rules for writing a migration (new file, RLS, idempotent guards, never apply from an unmerged branch), and "Security practices" holds the RLS and `REVOKE` rules. This file covers how migrations deploy, backups, and where the database is hosted. Pushes that touch only `supabase/` do not deploy the website.

## Database / migrations

The schema is the migrations: timestamp-prefixed files in `supabase/migrations/`, starting from `20260331000000_baseline.sql`. (`supabase/schema.sql` is a stale early snapshot — 4 tables, last touched August 2026 — kept for reference only; don't read it as current.) The sequential `-- Migration NNN` header comments and the older `migration-NNN-*.sql` copies are historical reference only — the sequence has gaps.

**Auto-deploy:** `supabase-migrate.yml` runs `supabase db push --db-url` on every push to `main` touching `supabase/migrations/`. Its one secret, `SUPABASE_DB_URL` (the Session pooler connection string, password included), is **shared with `db-backup.yml` — don't remove it while either workflow exists.** It replaced `SUPABASE_ACCESS_TOKEN` + `supabase link` on 2026-10-06: Supabase no longer issues classic access tokens, and scoped ones can't run `supabase link` (supabase/supabase#50244).

Applying a migration to production from an unmerged branch blocks every later migration; the root `CLAUDE.md`, "Database changes", has that rule. **A change made straight in the Supabase dashboard, or by a tool that applies migrations, does the same**: `pin_function_search_path` reached production that way on 2026-11-09 with no file here, and the only sign for a week was a red "Supabase Preview" check on every commit. If that check says `Remote migration versions not found in local migrations directory`, compare `supabase_migrations.schema_migrations` with this folder, and add the missing version as a file under the same timestamp, with the statements production recorded.

**Local dry-run:** `npm run migrate:link` once, then `npm run migrate:dry-run`. Both that and `migrate:list` use `--linked`; the CLI dropped `--project-ref`, and passing it prints a help blob and exits *without checking anything*, which reads like a clean run. If you see `Cannot find project ref`, run the link step. The dry run can't validate SQL — for that, run the migration against a throwaway Postgres in Docker.

## Backups

**Backups:** Pro keeps daily backups for 7 days, inside the Supabase account and restorable only back into Supabase. `db-backup.yml` keeps a second copy that covers what those don't — 30 days, another vendor, our own key, plain SQL, and a restore proven every run: it dumps the database nightly, encrypts it with age, uploads it to the `unstream-db-backup` R2 bucket, and restores the dump into a throwaway local stack before finishing. A failed run opens a "Database backup failing" issue. Restore steps, and what the backup doesn't hold: `docs/database-backups.md`. **Both this and `supabase-migrate.yml` pin the Supabase CLI version rather than taking `latest`** — resolving `latest` is an unauthenticated api.github.com call sharing a 60/hour limit with every runner on the IP, and it failed a nightly backup on 2026-10-20. Bump the pin deliberately, in both files together. The restore proof's local Auth, though, follows production's version each run (read from `/auth/v1/health` into `supabase/.temp/gotrue-version`): Supabase upgrades hosted Auth on its own schedule, and a local Auth older than production's lacks columns the dump fills (2026-11-16, `link_token_hash`).

## Plan and provider decisions

**On Supabase Pro since 2026-10-19** (planned 2026-10-06, for the dedicated instance that fixes free-tier outages like the 09-19 wedge). If Pro's disk throttling ever shows up, add Small compute (2 GB) first. Pro's own 7-day backups don't retire `db-backup.yml` — see Backups above for what each one covers. If the database ever leaves Supabase the company, the recommended route (2026-10-19) is Supabase's own open-source stack on Hetzner, via Elestio or Coolify, which keeps the code and sign-in unchanged ("Later: the database" in `docs/specs/infrastructure-independence-plan.md`); a move to DigitalOcean Managed PostgreSQL stays fully planned in `docs/specs/digitalocean-database-plan.md`. Read both before proposing a database move. **The hosting plan** (`docs/specs/infrastructure-independence-plan.md`, 2026-10-18) leaves the database and sign-in on Supabase. Its app move to Cloudflare Workers was **shelved on 2026-10-23**: the app stays on Netlify, and `docs/specs/hosting-contingency-plans.md` covers what to do if that has to change. Read both before proposing any hosting or provider change.

The app's side of the hosting decision is in the root `CLAUDE.md`, "Cloudflare Workers: tried and removed". One thing the port taught that any move off Netlify will meet:

- **Netlify keeps secret-flagged env vars write-only.** `netlify env:get` returns sixteen
  asterisks and the last four characters, and the dashboard can't reveal them. Anything copying
  values out of Netlify must detect that mask, and the real values come from where they were made.
