# Two-step verification (TOTP + passkeys) — spec

> **Passkeys removed, 2026-11-01.** Shipped in #738 and taken out the same
> day: this Supabase project's dashboard has no WebAuthn row under
> Authentication → Multi-Factor, so every "Add passkey" failed with "MFA
> enroll is disabled for WebAuthn", and the passkey-only settings page offers
> passwordless sign-in, not a second factor. Two-step verification is
> authenticator apps (TOTP) only. Everything below about passkeys is the
> original design, kept for when Supabase offers the switch; the code is in
> #738's history. Passkeys as a *sign-in method* shipped instead: see
> `passkey-sign-in-spec.md`.

Status: implemented November 2026. Scope chosen by Brandon: **TOTP and passkey
second factors on the current `@supabase/supabase-js@2.99.1`** — no dependency
upgrade. Passwordless *passkey sign-in* (`signInWithWebAuthn`, which needs a
newer SDK plus the dashboard "sign in with passkeys" toggle) is a follow-up,
not this build.

## Why

Accounts are single-factor today: a magic link or a password, both of which
boil down to control of one email inbox. For fans that's a saved-artists list;
for artists a claimed profile, and claimed profiles are the takeover target —
vandalism and disruption of their revenue links. Two-step verification means a
stolen password (or inbox) is no longer enough to take an account over.

## Model: Supabase Auth MFA, in the terms this codebase uses

- A **factor** is a second step: a TOTP secret (authenticator app) or a
  WebAuthn credential (a passkey in Touch ID, a phone, a hardware key).
- A sign-in via password or magic link yields an **aal1** session —
  authenticated by one factor. Completing an MFA challenge reissues the
  session at **aal2**. The level is a claim (`aal`) on the access token, and
  the session's user object carries `factors`, so the client can answer "does
  this account have a second factor, and has this session completed it?"
  locally, with no network call.
- All enrollment and challenge traffic goes **from the browser straight to
  Supabase Auth**. No Unstream API function is involved, so none of this
  spends the site's Redis budget or hits the API rate limiter.

## What was built

1. **`utils/mfa.ts`** — pure helpers: `decodeAalClaim(accessToken)` (decodes
   the JWT payload, no verification — the token is Supabase's), and
   `needsSecondFactor(session)`: true when verified factors exist and the
   session's `aal` claim is not `aal2`. A token that fails to decode counts as
   *needing* the challenge — the gate must fail closed; the worst case of
   wrongly asking is one redundant challenge, the worst case of wrongly
   letting someone through is no second factor at all.

2. **`services/mfa.ts`** — the Supabase calls, each returning
   `{ error }` like the rest of `services/auth.ts`: `listMfaFactors`,
   `enrollTotp` (QR + secret), `verifyTotpEnrollment`, `unenrollFactor`,
   `enrollPasskey` (enroll → challenge → `navigator.credentials.create` →
   verify), `verifyWithTotp` / `verifyWithPasskey` (the sign-in step-up),
   `passkeysSupported()`.

3. **The sign-in gate.** `AuthContext` renders `MfaChallengeGate` instead of
   the app whenever `needsSecondFactor(session)` is true. That covers all
   three ways an aal1 session can appear: password sign-in, a magic-link
   click-through, and a stale session from before this shipped. The gate asks
   for a code (TOTP) or a passkey tap (WebAuthn), whichever factors the
   account has; verifying reissues the session at aal2, the auth event swaps
   the gate away, and the user continues where they were headed — the
   post-sign-in navigation happens under the gate, so the destination is
   intact. Escape hatch: sign out.

4. **`/settings` → "Two-step verification" section** (`id="two-step"`,
   below Password). Status, factor list with two-click remove, "Add
   authenticator app" (QR + manual-entry secret + code confirmation) and
   "Add passkey" (hidden where the browser has no WebAuthn support). Only
   verified factors are shown; an abandoned enrollment is cleaned up by
   unenrolling its unverified factor.

5. **One-time nudge on `/my-collection`.** `SecurityNudgeBanner` under
   `WelcomeBanner`, shown when the signed-in account has no verified factor.
   Dismissal is written to `user_metadata.security_nudge_dismissed_at` —
   the `WelcomeBanner` pattern — so it sticks across devices, and the banner
   never appears for an account that has (or later adds) a second factor.

6. **`me-password` requires aal2 when the account has factors.** Defense in
   depth: the gate normally guarantees aal2 by the time anyone is in
   `/settings`, but a stolen aal1 session must not be able to rotate the
   password — the one endpoint that hands over the account. When the
   presented token is not aal2, the service role lists the account's
   factors; any verified factor → 403. If the factor lookup itself fails the
   request is refused (500) rather than guessed at — password changes are
   rare, so failing closed costs almost nothing and failing open costs the
   feature's whole point.

7. **Artist, money, email, key and admin endpoints require aal2 too**
   (added in review, 2026-11-01). The gate is only UI: anyone with a stolen
   password can sign in from a script and call `/api` directly, so the
   endpoints a takeover would actually use refuse an aal1 session for an
   account with a verified factor (`middleware.ts`):
   - `authenticateBearer` checks the `factors` that its `getUser` call
     already returns — no extra round trip. That covers `artist-releases`,
     `tips-connect`, `tips-settings`, `api-key-generate` and every admin
     endpoint (`authenticateAdmin`).
   - `artist-profile` (profile and payment links) does the same in its own
     `getUser`.
   - `me-email` (the confirmation goes to the *new* address, so it is a
     takeover path), `artist-promote` and `me-buffer` verify the token
     locally, so they call `sessionMissingSecondFactor`: an aal2 token
     answers at once, an aal1 one costs one `getUser` to read the factors,
     and a failed lookup refuses the request.

## Dashboard prerequisites (Brandon, manual)

- **WebAuthn as an MFA method must be enabled** in the Supabase dashboard:
  Authentication → MFA → WebAuthn, with Relying Party ID `unstream.stream`
  and origins `https://unstream.stream` (add `https://www.unstream.stream`
  if that host is ever served). Until this is on, "Add passkey" fails with a
  Supabase error, which the UI shows as-is. TOTP needs nothing — it's on by
  default.
- **WebAuthn cannot be exercised on localhost.** The RP ID is
  `unstream.stream`, and a WebAuthn ceremony on `http://localhost:8888`
  can't match it. Passkey flows are testable only against production (or a
  staging Supabase project); TOTP is testable anywhere.
- **Recommended companion setting:** Authentication → "Require
  reauthentication" for email/password changes. That closes the raw
  `supabase.auth.updateUser` path (used by first-password-set and reset)
  at the Supabase layer, which an app-side check cannot reach.

## Limitations, accepted on purpose

- **Fan endpoints still accept aal1.** Saved artists, sync, listening and
  the other `me-*` settings take an aal1 session. Reason: the Mac app and the
  browser extension hold Supabase sessions and have no UI to answer an MFA
  challenge, and those are the endpoints they call; enforcing aal2 there
  would break them for every MFA-enabled user. What a stolen password can
  reach through them is a fan's saved list, not an artist's money or the
  account itself (see 7 above).
- **No backup codes.** Supabase Auth doesn't issue them. A user who loses
  every factor is locked out; recovery is manual — delete the factor in the
  Supabase dashboard (Authentication → the user → factors, or
  `auth.admin.deleteFactor`) at Brandon's hand, requested by email. The
  enrollment UI tells the user to keep the secret; enrolling a passkey
  *and* an authenticator app is the poor man's backup.
- **Every sign-in challenges.** No "remember this device" relaxation;
  Supabase sessions are long-lived, so the step-up happens per sign-in, not
  per page load.
- **The Mac app and extension are unchanged.** They sign in at aal1 and
  keep working (see the first limitation). A Mac-app TOTP prompt is a
  natural follow-up in `apps/mac`.

## Testing

- `apps/web/tests/unit/mfa-utils.test.ts` — AAL decode (valid, malformed,
  missing claim), `needsSecondFactor` matrix, QR data-URI shaping,
  passkey support detection.
- `apps/web/tests/unit/MfaChallengeGate.test.tsx` — gate renders for each
  factor combination; wrong code surfaces an error; verify success path;
  sign-out escape.
- `apps/web/tests/unit/TwoFactorSection.test.tsx` — status text, enroll
  flow (mocked service), two-click remove, unverified-factor cleanup.
- `apps/web/tests/unit/SecurityNudgeBanner.test.tsx` — shown for an
  account without factors, hidden when dismissed or enrolled, dismissal
  writes the metadata.
- `api/functions/__tests__/me-password.test.ts` — 403 at aal1 with a
  verified factor; proceeds at aal1 with none; proceeds at aal2; fails
  closed when the factor lookup errors.
- Manual E2E: TOTP enroll → sign out → sign in → challenge → aal2, against
  `npm run dev` (production Supabase). A scripted pass of that flow was attempted
  from the worktree but stops at Supabase's email confirmation — creating a
  smoke account is easy, confirming its email isn't, without an inbox. The
  auth-layer calls themselves were verified against the installed auth-js
  source (challenge/enroll/verify request shapes), not from memory.
  Two-minute manual check for Brandon once merged, with any real account:
  /settings → Two-step verification → Add authenticator app → scan → enter
  code → sign out → sign in → the gate asks for the code → done. A smoke
  account (`unstream-2fa-smoke@kidlightbulbs.com`, unconfirmed, inert) was
  created in production auth during the attempt and can be deleted in the
  dashboard. WebAuthn flows are typechecked and unit-tested only until the
  dashboard toggle is on.
