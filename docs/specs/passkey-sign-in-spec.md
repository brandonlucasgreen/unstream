# Passkey sign-in — spec

Status: built November 2026. Supabase calls the API experimental.

## Why this and not passkeys as a second step

Passkeys as a second step (WebAuthn MFA) shipped in #738 and came out the same
day: this project's Supabase dashboard has no WebAuthn row under
Authentication → Multi-Factor, so enrolling one always failed with "MFA enroll
is disabled for WebAuthn" (see `two-factor-auth-spec.md`). What Supabase does
offer is passkeys as a **sign-in method**, under Authentication → Passkeys: a
passkey in place of a password or an emailed link. That is what this builds.

## What people see

- **`/settings` → Passkeys** (`PasskeysSection.tsx`): add a passkey (the
  browser's own prompt), see each one by the name Supabase derives from where
  it's stored ("iCloud Keychain", "1Password"), when it was added and last
  used, and remove one (two clicks). The copy says plainly that a passkey
  replaces the password and is not a second step.
- **`/login`**: a "Sign in with a passkey" button under the sign-in-link
  button, and the email field offers saved passkeys in its autofill
  (`autocomplete="username webauthn"`, WebAuthn conditional UI). Both are
  hidden where the browser can't run passkeys.

## How it fits with two-step verification

A passkey sign-in yields an **aal1** session, the same as a password (observed
in supabase/supabase discussion #51228; not yet documented). So an account
with an authenticator app still meets `MfaChallengeGate` after a passkey
sign-in, and every server-side aal check still holds. Supabase lets an aal1
session register a passkey, so someone with a stolen password could add one —
and it would still stop them at the authenticator-app code. Don't treat a
passkey session as aal2 unless Supabase starts issuing it as one.

## The autofill prompt

It starts by itself whenever the sign-in form is on screen, and waits until
the person picks a passkey or leaves. Three rules (`LoginPage.tsx`,
`services/passkeys.ts`):

- The browser runs one WebAuthn prompt at a time, so the button aborts the
  autofill prompt before starting its own, and restarts autofill if its own
  prompt didn't sign anyone in.
- Its challenge expires after five minutes. A passkey picked later comes back
  `webauthn_challenge_expired`; the page says "choose your passkey again" and
  starts a fresh prompt.
- A failure *before* anyone picked a passkey (anything that isn't a
  `webauthn_*` verification code) is never shown on the page, since nobody
  asked for anything. It still goes to Sentry, except `passkey_disabled`,
  which the button reports when someone actually presses it.

## Limits

- **Production origin only.** The Relying Party ID is `unstream.stream`, so
  passkeys can't be exercised on localhost or a deploy preview. Unit tests
  cover the logic; the ceremony itself is tested by hand on unstream.stream.
- **Experimental API.** `@supabase/supabase-js` is pinned to an exact version
  (2.118.0). Upgrade it deliberately and re-test passkey add, sign-in and
  autofill on unstream.stream when you do.
- **Web only.** The Mac app and browser extension sign in as before.

## Recovery

Losing a passkey isn't a lockout: password and sign-in links still work. To
revoke one for someone (a lost device they're worried about), call
`auth.admin.passkey.deletePasskey({ userId, passkeyId })` with the service key;
`auth.admin.passkey.listPasskeys({ userId })` finds the id.

## Dashboard prerequisites

Authentication → Passkeys: **Enable Passkey authentication** on, Relying Party
ID `unstream.stream`, origin `https://unstream.stream`. On as of 2026-11-01.
