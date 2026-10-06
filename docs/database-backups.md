# Database backups and restores

Supabase's free plan keeps no backups we can restore, so `.github/workflows/db-backup.yml` makes
its own. This page covers what it keeps, how to tell it's working, and how to restore. Every
command here was tested against a local Supabase stack built from `supabase/migrations/`.

## What's kept, and where

- **When:** nightly at 09:17 UTC. Run it any time from Actions → Database backup → Run workflow.
- **Contents:** one file per night, `daily/unstream-db-<date>.tar.gz.age`. It holds three files
  from `supabase db dump`:
  - `roles.sql`
  - `schema.sql`
  - `data.sql`, which covers every row in the `auth` schema (accounts and password hashes) and
    the `public` schema (everything Unstream stores).
- **Where:** the private Cloudflare R2 bucket `unstream-db-backup`. An R2 lifecycle rule deletes
  files after 30 days.
- **Encryption:** each file is encrypted with [age](https://age-encryption.org) to the public key
  in `.github/db-backup-recipients.txt`. **The private key, `unstream-backup.key`, lives only in
  the owner's password manager.** Without it, no backup can be read. Keep a second copy somewhere
  offline.
- **Restorable, every night:** after uploading, the workflow restores the same dump into a
  throwaway Supabase stack and checks every table's row count
  (`.github/scripts/db-restore-check.sh`).

## Is it working?

- **An open issue titled "Database backup failing" means it isn't.** The workflow opens one on any
  failed run, comments on it if failures continue, and closes it on the next success.
- The newest file in the bucket should be less than a day old.

## Not in the backup

These are configuration rather than data. They only matter if the whole project has to be
recreated:

| What | How it comes back |
|---|---|
| pg_cron jobs | Recreate them (scenario B, step 4). |
| Migration history | `supabase migration repair` (scenario B, step 3). |
| Auth settings: site URL, redirect URLs, SMTP, email templates | Re-enter them in the new project's Auth settings. They live in the Supabase dashboard, not the database. |
| Project URL, API keys, JWT secret | A new project gets new ones; scenario B, step 5 swaps them in. |
| Supabase Storage files | Unstream doesn't use Storage. |

---

## Get a backup and decrypt it

You need Docker, the Supabase CLI and `age` (`brew install supabase/tap/supabase age`).

1. **Recreate the key file.** Copy the `AGE-SECRET-KEY-1…` line from the password manager, then:

   ```bash
   pbpaste > unstream-backup.key && chmod 600 unstream-backup.key
   age-keygen -y unstream-backup.key   # must print the age1… key in .github/db-backup-recipients.txt
   ```

   That one line is the whole key; the comment lines `age-keygen` writes around it don't matter.
   `pbpaste` keeps it out of shell history. Delete the file when you're done.
2. **Download.** In the Cloudflare dashboard go to R2 → `unstream-db-backup` → `daily/`, then
   download the newest file, or the newest from before the problem started.
3. **Decrypt and unpack:**

   ```bash
   mkdir restore
   age --decrypt --identity unstream-backup.key unstream-db-<date>.tar.gz.age | tar -xz -C restore
   ```

   `restore/` now holds `roles.sql`, `schema.sql` and `data.sql` **in plain text, including
   emails and password hashes.** Delete it when you're done.

## Scenario A: some rows were lost or damaged (the likely one)

For example, a migration or a script deleted or overwrote data. Production stays up throughout;
you restore into a local copy, then copy back only what's missing.

1. **Start an empty local Supabase** (Postgres and Auth only), outside the repo:

   ```bash
   mkdir restore-db && cd restore-db && supabase init --force
   supabase start -x realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
   ```

2. **Restore into it.** The script refuses a database that isn't empty, and checks every table's
   row count:

   ```bash
   <repo>/.github/scripts/db-restore-check.sh restore postgresql://postgres:postgres@127.0.0.1:54322/postgres
   ```

3. **Find what's missing.** Query the local copy at
   `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, comparing it with production.
4. **Copy it back.** Export the rows from the local copy with
   `\copy (SELECT ...) TO 'rows.csv' CSV` and load them into production with `\copy`, or turn
   them into `INSERT ... ON CONFLICT DO NOTHING` statements. Have the owner review the exact rows
   before anything writes to production.
5. Run `supabase stop --no-backup` and delete `restore/`.

## Scenario B: the Supabase project is gone or unusable

This is a bigger event. **Data comes back** (up to a day of it can be lost) and **passwords keep
working**, because the hashes are restored. But the project URL and keys change, so **every user
has to sign in again**, and the **Mac app and browser extension need a release**, since both
hardcode the project URL.

1. **Create a new Supabase project** in the same region, and note its database password.
2. **Restore into it.** Use the new project's connection string: Connect → Session pooler,
   password filled in.

   ```bash
   <repo>/.github/scripts/db-restore-check.sh restore '<session-pooler-connection-string>'
   ```

3. **Restore the migration history**, so `supabase db push` keeps working:

   ```bash
   supabase migration repair --db-url '<session-pooler-connection-string>' \
     --status applied $(ls supabase/migrations | cut -d_ -f1)
   ```

4. **Recreate the pg_cron jobs** in the SQL editor:

   ```sql
   SELECT cron.schedule('gc-saved_artists_tombstones', '0 3 * * *', $$SELECT gc_saved_artists_tombstones();$$);
   SELECT cron.schedule('rollup-app-events', '20 3 * * *', $$SELECT rollup_app_events();$$);
   ```

   Check this list against `cron.schedule` calls in `supabase/migrations/` for any job added
   after 2026-10-06.
5. **Point everything at the new project:**
   - **Netlify env vars:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`,
     `SUPABASE_JWT_SECRET`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Then redeploy.
   - **GitHub secret `SUPABASE_DB_URL`:** the new project's session pooler connection string.
     Both `supabase-migrate.yml` and `db-backup.yml` read it.
   - **The Mac app:** the URL in `apps/mac/Unstream/Services/AuthService.swift` and the anon key
     in `Info-macOS.plist` and `Info-iOS.plist`. Ship a release.
   - **The extension:** the URL and anon key in `apps/extension/lib/supabase.js`. Ship a release.
6. **Re-enter the Auth settings** (see "Not in the backup").
7. **Smoke-test:** sign in with an existing account, check its saved artists, an artist page, and
   search.

## Drill

The nightly run already proves the dump restores. A drill proves the rest: the private key
works, and the file can be downloaded and decrypted. **Do one after the first backup, then every
few months:** "Get a backup and decrypt it", then scenario A steps 1–2, then stop.

## Changing the key

`age` accepts several recipients. Add the new public key as a line in
`.github/db-backup-recipients.txt`, then remove the old line once you're sure the new private key
is stored safely. Files already in the bucket still need the key they were encrypted with, until
they age out after 30 days.
