---
status: Done
---
# UNS — Allow a listener to share or publicize a saved artist list

**GitHub Issue:** [#31](https://github.com/brandonlucasgreen/unstream/issues/31)
**Spec body:** GH issue body is the source of truth (this doc is the working expansion for Daryl)
**Owner:** Daryl
**Reviewer:** Brandon (via Claude Code — Dan review intentionally skipped for this round; the auth work is small and contained)
**Coordinator:** Wayne
**Status:** Approved by Brandon 2026-06-27 13:50 ET, split into 2 PRs. **Amended 2026-06-27 18:07 ET** with rate-limit tier, SEO/static-rendering override, no-notifications, and reserved-handle list (see "Amendments" section below).
**Lane:** Maintenance mode (Unstream) — explicit opt-in by Brandon on 2026-06-27 to spec the open feature issues against GitHub, not Linear.

## Amendments (2026-06-27 18:07 ET)

Applied after PR 1 (#294) merged. The original 13:50 ET spec left four product/architecture decisions explicitly open; Brandon answered three inline on 2026-06-27 18:07 ET. Wayne made the rate-limit call (Brandon delegated).

| # | Decision | Resolution | Source |
|---|---|---|---|
| 1 | Rate-limit tier on `GET /api/public/saved-artists/{handle}` | **`standard` (30/min/IP)** — same as existing public endpoints. If abuse emerges, tighten to `strict` (10/min) as a follow-up. No new tier for v1. | Brandon: "defer to your judgment to minimize abuse" |
| 2 | SEO / static vs SPA rendering for `/u/{handle}` | **Static HTML edge function, same as `/a/{slug}`** (model: `api/edge/artist-page-static.ts`). React app hydrates client-side for interactive bits (Copy URL button, future Follow/Save). The edge function is the single renderer per CLAUDE.md "one route, one renderer"; hydration is progressive enhancement, not a second renderer. | Brandon: "seo same rule" |
| 3 | Notifications / vanity metrics | **No view counter, no notification emails in v1.** Skip the counter entirely. If vanity metrics are wanted later, that's a separate PR. | Brandon: "no notifications" |
| 4 | Reserved-handle list for `/u/{handle}` | **Proposed default (Brandon has not yet confirmed):** `admin, api, settings, login, signup, signin, register, logout, support, about, privacy, terms, dashboard, u, a, artist, www, mail, ftp, root, help, docs, status, blog`. Apply as a CHECK constraint at the DB layer and a server-side validator. **OPEN — confirm before Daryl starts.** | Wayne proposal, pending Brandon confirmation |

The original spec body below is annotated where these amendments override it. Search for `<!-- AMENDED 2026-06-27 18:07 ET -->` for inline changes.

## Why this exists

The saved artists list is currently private — only visible inside `/dashboard` for the logged-in user. The product opportunity is to make the list *optionally* shareable so it becomes a discovery + social-proof surface without turning Unstream into a full social network.

This is the smallest social surface we can ship: one privacy toggle, one public URL per user, one read-only public page.

## Product framing (from GH #31, restated)

- **Goal:** turn the private saved artists list into an *optionally* public list. The shared view is for discovery ("here's who's on my list") and lightweight social proof ("here's who I support on Unstream"). It is NOT a social feed.
- **User story:** as a logged-in user, I can make my saved artists list public and share a URL with other people so they can browse my saved/supported artists.
- **Out of scope (v1):** following other users, comments/likes/reactions, per-artist privacy, multiple named lists, collaborative editing, recommendation ranking, third-party list sync.

## Brandon's decisions (inline, 2026-06-27 13:50 ET)

1. **Public identifier shape: per-user handle.** v1 uses `/u/{handle}` where `handle` is a username the user sets explicitly. **Username is required before sharing can be enabled** (UI gate + API guard). This means a Settings page ships first as a dependency.
2. **Attribution label:** default to the user's display name + a generic "by [name]" header on the public page. Fall back to email prefix or generated handle if no public-facing display name exists.
3. **UNS-66 (supported flag) shipped.** Confirmed by Brandon — already live. Daryl can use the existing supported flag in the public response without blocking.
4. **Two specs, two PRs.** PR 1 = Settings page (username setter + password change). PR 2 = public sharing (depends on PR 1). Smaller PRs, faster review cycles.
5. **Username validation rules (proposed, default unless overridden):**
   - Length: 3-20 characters.
   - Charset: lowercase alphanumeric + hyphens. No leading/trailing hyphen.
   - Uniqueness: enforced server-side; collision returns a friendly error.
   - Mutability: editable from Settings. Renaming changes the share URL (and breaks old shared URLs — old URLs return 404 on the new handle).
6. **Password change UI:** "current password + new password" form, presuming Supabase supports `supabase.auth.updateUser({ password })` with current-password verification. If that pattern isn't already in the codebase, Daryl picks the simplest working approach and documents it in the PR.

---

# PR 1: User Settings page (username + password change)

## What to build

### 1. Database — username column on the user table

```sql
ALTER TABLE <user-table>
  ADD COLUMN username TEXT UNIQUE
    CHECK (username ~ '^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$');  -- 3-20 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen
```

The check constraint enforces the format at the DB layer (defense in depth). Uniqueness is enforced by the UNIQUE constraint. Both errors should be caught server-side and translated to friendly messages.

**RLS:**
- `username` is readable by the owning user only. Anon cannot read usernames. The public endpoint (PR 2) returns the username as part of `owner_display_name`, but that comes through the public-saved-artists endpoint, not from reading the user table directly.

### 2. API endpoints

**New endpoints:**

- `GET /api/me/settings` — returns the current user's `username` (or `null` if not set), email (for confirmation only — never returned to anon), and `has_password` (boolean; if the user signed up via magic link only, they don't have a password).
- `POST /api/me/username` — body `{ username: string }`. Validates format + uniqueness. Returns the new username or a friendly error (`"Username is already taken"`, `"Username must be 3-20 characters"`, etc.).
- `POST /api/me/password` — body `{ current_password: string, new_password: string }`. Verifies current password, updates via Supabase auth. Returns success or error. **Never log the passwords.** Reject empty new passwords; require min length (8 chars).

**Existing endpoints to reuse:**

- `/api/me/*` patterns (if they exist) — match the conventions.

### 3. Frontend — Settings page

**New route:** `/settings` (verify it doesn't collide with `/a/*`, `/artist/*`, `/dashboard`, `/u/*`, etc.).

**Page layout (single column, ~600px max width, centered):**

- **Section 1: Profile**
  - Username input (current value or placeholder if not set)
  - Save button (validates client-side, server-side is the source of truth)
  - Helper text: "Your username is used in the public URL when you share your saved artists. 3-20 characters, lowercase letters, numbers, and hyphens."
  - Inline error display below the input.
- **Section 2: Password** (only if `has_password = true`)
  - "Change password" form: current password, new password, confirm new password.
  - Save button.
  - Helper text: "Use at least 8 characters."
  - Inline error display.
  - **If the user signed up via magic link only** (`has_password = false`), show: "Your account was created with a magic link. To set a password, [send password-setup email]." (Defer the email flow if it adds scope; show a placeholder for now and file a follow-up.)

**Navigation:** add a "Settings" link to the dashboard nav (or wherever auth-aware nav lives) for logged-in users.

### 4. Files to touch / create

**New:**
- `api/functions/me-settings.ts` — `GET /api/me/settings`
- `api/functions/me-username.ts` — `POST /api/me/username`
- `api/functions/me-password.ts` — `POST /api/me/password`
- `apps/web/src/pages/SettingsPage.tsx` — main page component
- `apps/web/src/components/UsernameField.tsx`
- `apps/web/src/components/PasswordChangeForm.tsx`
- A new Supabase migration for the `username` column

**Modified:**
- `apps/web/src/App.tsx` — add `/settings` route
- `apps/web/src/components/Nav*` (whichever auth-aware nav component exists) — add Settings link
- `data/shipped-features.json` — add entry on merge

### 5. Tests

- Unit: `me-username.ts` validates format, rejects duplicates, accepts valid input.
- Unit: `me-password.ts` rejects wrong current password, rejects short new password, accepts valid pair.
- Unit: `<UsernameField>` shows inline errors on duplicate / invalid format / success.
- Unit: `<PasswordChangeForm>` shows inline errors on validation failures.
- Integration: set username → verify it's queryable. Change password → log out → log back in with new password.

### 6. Edge cases

- User sets username to one they already had before (no-op): should return 200 with current value.
- User renames username while a public share is active (PR 2): old `/u/{old_handle}` returns 404 (handled in PR 2's public endpoint). New `/u/{new_handle}` works.
- Username with leading hyphen (e.g. `-foo`): rejected by format check.
- Password change while logged in on multiple devices: Supabase invalidates other sessions by default — verify and document the behavior in the PR.

## Acceptance criteria (PR 1)

- [ ] Logged-in user can navigate to `/settings`.
- [ ] User can set their username; validation works client-side and server-side.
- [ ] Duplicate username is rejected with a friendly error.
- [ ] User can change their password; current password is required.
- [ ] Wrong current password is rejected with a friendly error.
- [ ] Password is never logged or returned in any API response.
- [ ] Username column is unique server-side; DB-level check constraint enforces format.
- [ ] Anon cannot read usernames via any endpoint.

---

# PR 2: Public sharing of saved artist list (depends on PR 1)

## What to build

### 1. Database — minimal user-level metadata for public sharing

```sql
ALTER TABLE <user-table>
  ADD COLUMN saved_artists_public BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE user_public_ids (
  user_id UUID PRIMARY KEY REFERENCES <user-table>(id) ON DELETE CASCADE,
  public_handle TEXT NOT NULL UNIQUE,    -- references username; we keep a separate column for explicit ownership semantics + future flexibility
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_public_ids_public_handle ON user_public_ids (public_handle);
```

**Why a separate `user_public_ids` table instead of just reading from `users.username`:**
- Explicit signal of "this user opted into sharing" (presence of a row = opted in).
- Future-proof for: revoking share, share history, multiple handles per user (out of scope but cheap).
- Cleaner RLS — `user_public_ids` is the public-readable surface, the user table is not.

**RLS:**
- `user_public_ids`: read-only for `anon` and `authenticated` (only the `public_handle` column is readable; `user_id` is server-side only).
- `saved_artists_public` flag: read+write only for the owning user; anon can never read it directly (only through the public endpoint, which checks the flag server-side).

**Public API contract:**
- Anonymous users can hit `GET /api/public/saved-artists/{handle}` — returns the user's saved artists + the `supported` flag, only if `saved_artists_public = true`.
- Anonymous users cannot tell *which* user owns the list from the response — return the username string as `owner_display_name`, never an email, user ID, or account metadata.
- Private lists (`saved_artists_public = false`) return a 404, not a 403.
- Renames (PR 1's username change): old handle returns 404 (the row in `user_public_ids` is not auto-updated on username change; either update it explicitly when sharing is enabled, or trigger on username change). **Default: update `user_public_ids.public_handle` whenever `username` changes AND the user has sharing enabled.** Simpler than tracking share history.
- **Rate limit (AMENDED 2026-06-27 18:07 ET):** `standard` tier (30/min/IP) on the public endpoint, matching existing public endpoints. Tighten to `strict` (10/min) if abuse surfaces.
- **No view counter, no notification emails in v1 (AMENDED 2026-06-27 18:07 ET).** Skip vanity metrics entirely. The public endpoint has no side effects beyond reading the saved_artists join.

### 2. API endpoints

**New endpoints:**
- `GET /api/me/saved-artists-sharing` — returns `{ public: boolean, public_handle: string | null, public_url: string | null }` for the current user. **404 if user has no username** (sharing requires username from PR 1).
- `POST /api/me/saved-artists-sharing` — body `{ public: boolean }`. Toggles the flag. If enabling for the first time, requires username to be set (returns 400 if not). Returns the new `public_url` on enable. Idempotent.
- `GET /api/public/saved-artists/{handle}` — public endpoint, returns the list. Anonymous-accessible. 404 if private, unknown handle, or username not set.

**Existing endpoints to reuse:**
- `GET /api/saved-artists` — already returns the user's saved artists. The public endpoint reuses this server-side with the user_id of the owner.

**Public response shape:**

```json
{
  "owner_display_name": "kidlightbulbs",
  "saved_artists": [
    {
      "slug": "band-name",
      "name": "Band Name",
      "image_url": "https://...",
      "supported": true
    },
    ...
  ],
  "updated_at": "2026-06-27T12:00:00Z"
}
```

`updated_at` is optional — skip if it adds complexity.

### 3. Frontend — `/dashboard` controls

**Add a "Sharing" section to the saved artists area of `/dashboard`.** Three states:

- **No username set:** "Set a username to share your saved artists. [Set username]" — links to `/settings`.
- **Username set, sharing private (default):** "Your saved artists are private. [Make public]" button.
- **Username set, sharing public:** "Your saved artists are public. [URL] [Copy] [Make private]" — three controls.

**UX details:**
- "Make public" / "Make private" are single-click toggles. No confirmation modals — the toggle is reversible.
- The copy button gives visible feedback ("Copied!" for ~2s).
- The section sits below the saved artists list, not above.

### 4. Frontend — public route

**Route:** `/u/:handle`. Static HTML edge function, same pattern as `/a/:slug` (model: `api/edge/artist-page-static.ts`). React app hydrates client-side for interactive bits only (Copy URL button; future Follow/Save actions).

**Page structure (server-rendered shell):**
- Use existing artist presentation components (`<ResultCard>` — name + image + click-through) for the static markup. Server-render the list directly in the edge function.
- Distinguish supported artists visually (existing `Supported*` primitive if there is one; else a small inline icon).
- Header: minimal — site logo + "A listener's saved artists on Unstream" + the username as attribution. NO auth-aware nav (per CLAUDE.md static-page convention — `/u/{handle}` is content, not app).
- Footer: same footer as static artist pages.
- Client-side hydration: the Copy URL button is the only v1 interactive control. Hydration is progressive enhancement; the page is fully functional without JS.

**One renderer only.** Per CLAUDE.md "One route, one renderer." The edge function is the single renderer. Client-side hydration is progressive enhancement, not a second renderer. <!-- AMENDED 2026-06-27 18:07 ET: changed from "SPA-only" to "static HTML edge function with hydration" per Brandon's "seo same rule" answer. -->

### 5. Files to touch / create

**New:**
- `api/functions/user-sharing.ts` — `GET/POST /api/me/saved-artists-sharing`
- `api/functions/public-saved-artists.ts` — `GET /api/public/saved-artists/{handle}`
- `apps/web/src/pages/PublicSavedArtistsPage.tsx` — public route component
- `apps/web/src/components/SharingControls.tsx` — dashboard widget
- `apps/web/src/components/SupportedBadge.tsx` — if no existing primitive
- A new Supabase migration for `user_public_ids` and `saved_artists_public`

**Modified:**
- `apps/web/src/App.tsx` — add `/u/:handle` route
- `apps/web/src/pages/DashboardPage.tsx` — mount `<SharingControls>` below the saved artists list
- `api/functions/saved-artists.ts` — verify the join pattern; reference for the new endpoints
- The PR 1 username-change endpoint: when username changes AND user has sharing enabled, update `user_public_ids.public_handle` in the same transaction (or via a trigger).
- `data/shipped-features.json` — add entry on merge

### 6. Tests

- Unit: `user-sharing.ts` flag toggle (enable / disable / idempotent re-enable / unauthorized / no-username-400).
- Unit: `public-saved-artists.ts` returns 404 for private, 404 for unknown handle, 200 for public with correct data shape (no email, no user_id, no extra fields).
- Unit: `<SharingControls>` renders the three states (no-username, private, public) correctly.
- Integration: enable sharing → fetch public URL → toggle off → confirm public endpoint returns 404.

### 7. Edge cases

- User enables sharing with zero saved artists → public page renders empty state (not an error).
- User toggles off after URL was shared → old URL returns 404.
- User unsaves an artist → public page reflects it on next fetch.
- User renames username (PR 1) while sharing is enabled → old handle returns 404, new handle resolves.
- Multiple clients open while saved/support states change → last-write-wins. No real-time sync required.

## Acceptance criteria (PR 2)

- [ ] Logged-in user can toggle saved-artists sharing on/off from `/dashboard`.
- [ ] Sharing is gated behind a username (set via `/settings`, PR 1).
- [ ] When sharing is enabled, user gets a stable `/u/{handle}` URL they can copy.
- [ ] Anonymous visitor can open `/u/{handle}` and see the user's current saved artists.
- [ ] Public page reflects which saved artists are marked supported.
- [ ] Unsaving an artist removes it from the public page on next fetch.
- [ ] Toggling sharing off makes `/u/{handle}` return 404.
- [ ] Renaming the username (PR 1) updates `user_public_ids.public_handle` if sharing is enabled.
- [ ] Public response never includes email, user_id, or other account metadata.
- [ ] Visitors cannot modify another user's list from the public page.

---

## Engineering principles (per CLAUDE.md)

- **Boring beats clever.** This is CRUD with a couple of toggles and read endpoints. No state machines, no optimistic concurrency, no caching layer. Resist the urge to add them.
- **One route, one renderer.** `/u/:handle` is SPA-only. `/settings` is SPA-only. Do not also server-render either via an edge function.
- **Match surrounding code.** Use existing artist presentation components. Use existing auth context. Use existing API function patterns.
- **RLS on every new table.** `user_public_ids` ships with RLS in the migration. The `username` column has appropriate read-restriction.
- **SSRF protection not needed** — no outbound fetches in this work.
- **No secrets, no PII in the public response.** Server-side response shaping; don't rely on client filtering.
- **No password logging.** Sanity-check the password endpoint's logs before merging.
- **Validate at boundaries.** Username format, password length, handle format — all validated server-side even if the client also validates.

## Implementation order

**PR 1 (Settings page):**
1. Migration (username column + check constraint + unique).
2. `me-settings.ts` + tests.
3. `me-username.ts` + tests.
4. `me-password.ts` + tests.
5. `<UsernameField>` + `<PasswordChangeForm>` + `<SettingsPage>` + nav wiring + tests.
6. End-to-end smoke: set username, change password, log out, log back in.
7. `data/shipped-features.json` entry.

**PR 2 (public sharing, after PR 1 merges):**
1. Migration (`user_public_ids` + `saved_artists_public`).
2. Update PR 1's username-change endpoint to sync `user_public_ids.public_handle` if applicable.
3. `user-sharing.ts` + tests.
4. `public-saved-artists.ts` + tests.
5. `<SharingControls>` + DashboardPage wiring + tests.
6. `PublicSavedArtistsPage` + route + tests.
7. End-to-end smoke.
8. `data/shipped-features.json` entry.

## Files for Daryl to reference

- `apps/web/src/contexts/AuthContext.tsx` — how the current user is resolved.
- `apps/web/src/pages/DashboardPage.tsx` — where to mount the new controls (PR 2) and where the nav lives (PR 1).
- `apps/web/src/components/ResultCard.tsx` — artist presentation primitive to reuse (PR 2).
- `api/functions/saved-artists.ts` — current saved-artists API surface; the new endpoints follow the same patterns (PR 2).
- `~/projects/unstream/CLAUDE.md` — Engineering principles + "One route, one renderer" rule.
- `~/projects/unstream/docs/retros/UNS-100-bifurcation-retro.md` — context on why single-renderer matters.
- Supabase auth docs for `updateUser({ password })` (PR 1) — verify the current-password verification pattern before implementing.