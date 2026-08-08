# Data collection audit

Written 2026-08-08, by reading the migrations and the functions rather than the old privacy
policy — which had drifted far enough that it was describing a different product.

This is the working inventory the [privacy policy](../../apps/web/src/pages/PrivacyPolicyPage.tsx)
is written from. **If a change alters what is collected, where it goes, or how long it's kept,
update both in the same PR.** The policy is the promise; this file is the evidence for it.

## The three categories

The distinction that matters, and the one most privacy policies fudge:

| | What it means | Can we trace it to a person? |
|---|---|---|
| **Anonymous** | No identifier of any kind | No, and never could |
| **Pseudonymous** | An identifier exists, but no name or email attached | Not by us, but it isn't "nothing" |
| **Identified** | Attached to an account | Yes |

Calling pseudonymous data "anonymous" is the standard overclaim. A hashed session token is still
an identifier. We put it in the middle column and say so.

## Anonymous

**`artist_analytics`** — daily counters per artist per metric (`search`, `view`,
`click:<platform>`). `analytics-event.ts` resolves a slug to an artist ID and calls
`increment_analytics(artist_id, date, metric)`. There is no user column, no session column, and
the request IP is used for rate limiting and then discarded. This is the one thing on the artist
dashboard, and it is genuinely anonymous.

## Pseudonymous

**`app_events`** — product usage events (`search`, `platform_click`, `extension_activated`,
`page_view`, `release_alert`, `download`). Two things keep this clean:

- `context` is filtered against an allowlist (`has_results`, `result_count`, `platform`,
  `streaming_service`, `page`) and non-primitives are dropped, so a client cannot smuggle a field
  in. `page` carries a label like `artist`, not a URL.
- `session_hash` is `HMAC-SHA256(ip + user_agent + date)` keyed with `SESSION_HASH_SECRET`. Daily
  rotation means no cross-day linkage, and the key means it can't be brute-forced back to an IP.

> The HMAC degrades to a plain SHA-256 if `SESSION_HASH_SECRET` is unset — and a plain SHA-256 of
> an IP is reversible, because the input space is small enough to enumerate. The fallback logs a
> warning. Confirmed 2026-08-08: the variable is set as a secret in Netlify's production
> environment, so the keyed path is the live one. Re-check it if the environment is ever rebuilt;
> the honesty of this whole row depends on it.

**Rate-limit keys in Upstash** — `rl:standard:<ip>`, `rl:daily:strict:<ip>` and friends, holding
raw IP addresses in sliding windows of up to 24 hours. An IP is personal data under GDPR. It is
short-lived and used for nothing else, but it is not anonymous and the policy says so.

**GoatCounter** — cookie-free, its own daily-rotating visitor hash.

## Identified — tied to an account

| Where | What |
|---|---|
| `auth.users` (Supabase) | Email, hashed password |
| `saved_artists` | `user_id`, artist, `notes`, `supported`/`supported_at`, `device_id`, tombstones |
| `usernames` | `user_id`, `username`, `location`, `saved_artists_public` |
| `release_feed_tokens` | `user_id`, secret feed token |
| `artist_profiles` | `user_id`, `email`, bio, image, website |
| `verification_requests` | `user_id`, `email`, free-text `message` |
| `api_keys` | `owner_email`, `owner_name`, `key_prefix`, `key_hash` (SHA-256 — the key itself is never stored) |
| Buttondown | Newsletter email + a source tag (`changelog` / `guides` / `settings`) |

`device_id` is a random UUID minted on first launch and kept in the keychain
(`DeviceIDManager.swift`). Not a hardware identifier — it says nothing about the device.

## Searches: not "not stored", but not linked to you either

The intuition that we don't store searches is half right, and the half that's wrong is worth
being precise about. **No search is ever written against a user account** — there is no search
history table, and signing in doesn't create one. But the search *terms* persist in four places,
all detached from any person:

1. **Upstash results cache** — `artist:<platform>:<normalized query>`, 30-minute default TTL.
2. **`bandcamp_slug_probes.query_norm`** — the normalized artist name is the primary key, stored
   indefinitely. This is deliberate and load-bearing: it's what stops us re-probing Bandcamp for
   every artist who isn't on it. The migration says "No PII" and that's correct.
3. **Netlify function logs** — cache keys are logged (`[Cache] SET: artist:mirlo:radiohead`), so
   artist names appear in short-lived operational logs.
4. ~~**GoatCounter page paths**~~ — no longer, see below.

### GoatCounter used to record the search term — fixed 2026-08-08

`count.js` was loaded with no settings object. GoatCounter's default path is
`location.pathname + location.search`, and a search sets `/?q=artist+name` via `setSearchParams`
in `App.tsx`, so every search was recorded as a page view of a path containing the artist name —
on a dashboard the README advertises as public.

`index.html` now sets the path explicitly before `count.js` loads:

```html
<script>window.goatcounter = { path: function () { return location.pathname || '/' } }</script>
```

Keep that script tag ahead of `count.js` — settings are read at load time, so ordering is what
makes it work, and a silent revert to the default is the failure mode. Events fired from
`services/analytics.ts` pass an explicit path and were never affected. Only the SPA loads
GoatCounter; the edge-rendered pages don't include it at all.

The deliberate exception is Sentry, which still receives the full page URL on an error. That is
the point: a search that returns nothing useful is only diagnosable if you know what was searched
for. Disclosed in the privacy policy rather than quietly stripped.

## Private by default — verified, not assumed

- `usernames.saved_artists_public` is `BOOLEAN NOT NULL DEFAULT false` (migration 022). Sharing is
  opt-in.
- `usernames.location` is nullable with no default (migration 024), and renders only on
  `/u/:handle`, which 404s unless sharing is on. Setting a username alone publishes nothing.
- Migration 023 dropped the `USING (true)` anon SELECT policy on `usernames` that would otherwise
  have exposed every user ID and handle. The reasoning in that file — *RLS is row-level, not
  column-level* — is the single most useful sentence in the migration history. Apply it whenever
  writing a policy.
- `saved_artists` policies are all `auth.uid() = user_id`.
- The public list endpoint returns username, saved artists, supported flags and location. Never
  email, never notes.

## Retention

| Data | Kept for |
|---|---|
| Account data | Until deletion is requested |
| `saved_artists` tombstones | 30 days, then hard-deleted by a scheduled sweep (migration 018) |
| Search results cache | ~30 minutes |
| Rate-limit keys | ≤ 24 hours |
| `bandcamp_slug_probes` | Indefinite (no personal data) |
| `artist_analytics` | Indefinite (anonymous) |
| `app_events` | Rows kept indefinitely; `session_hash` nulled after 90 days by a nightly sweep, after which the row is fully anonymous |
| Newsletter | Until unsubscribe |

## Processors

Netlify (hosting/functions), Supabase (database/auth), Upstash (cache/rate limits), GoatCounter
(analytics), Sentry (errors), Buttondown (newsletter), Liberapay and Apple (payments — we never
see card details), Discord (bot). All US-based, so UK/EEA users' data is transferred out of
region.

Sentry runs with `sendDefaultPii: false`, `tracesSampleRate: 0`, no Session Replay, and a
`beforeSend` that drops noise. Note that error events still carry the page URL, which for a search
includes the query string — the same caveat as GoatCounter.

Upstream data sources (MusicBrainz, Wikidata, Wikipedia, Discogs, Bandcamp, Mirlo, and the rest)
receive an artist name to search for and nothing about the person searching.

## Client-side only

- **Extension** — saved artists and a slug cache in `chrome.storage.local`; a notifications
  preference in `chrome.storage.sync`. `lib/supabase.js` only ever calls `/auth/v1` endpoints.
- **Apple apps** — saved artists on device; ListenBrainz and Plex tokens in the keychain.
  Scrobbles go from the device straight to ListenBrainz; they never pass through us.

## Open items

- [x] Confirm `SESSION_HASH_SECRET` is set in Netlify Functions (production) — confirmed
      2026-08-08, set as a secret.
- [x] Stop GoatCounter receiving `?q=` search terms — done 2026-08-08.
- [ ] Purge the historical `/?q=…` paths already in GoatCounter (Settings → Manage pageviews).
      The fix stops new ones; it doesn't touch what's already recorded.
- [x] Add a retention sweep for `app_events` — done 2026-08-08. `session_hash` is nulled at 90
      days rather than the row deleted, so every dashboard count survives and the row stops
      being personal data. `session_hash` only ever deduplicated within a single day, so past 90
      days it had no analytical value left.

## A note on writing RLS policies here

Two mistakes have now been made twice in this repo, and both are cheap to avoid:

1. **RLS is row-level, not column-level.** A policy that exposes a row exposes every column in
   it. Migration 023 learned this on `usernames.user_id`; `artist_profiles.email` was the same
   bug, found in the 2026-08-08 audit.
2. **`CREATE POLICY` with no `TO` clause applies to `PUBLIC`, which includes `anon`.** A policy
   named "Service role full access" that omits `TO service_role` grants that access to anyone
   holding the public anon key. The service role has `BYPASSRLS` and never needed a policy in
   the first place — so the correct fix is to delete the policy, not re-scope it.

The model to copy is in `20260731120000_releases.sql`: public reads via an explicit `SELECT`
policy, writes left with no policy at all, and a comment saying the absence is deliberate.
Supabase's `ALTER DEFAULT PRIVILEGES` also grants `anon`/`authenticated` full table privileges on
every *new* table, so anything holding private data wants an explicit
`REVOKE INSERT, UPDATE, DELETE … FROM anon, authenticated` too.
