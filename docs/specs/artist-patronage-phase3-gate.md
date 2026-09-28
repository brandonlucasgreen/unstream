---
status: Blocked
---
# Artist patronage: the Phase 3 gate

**Written:** 2026-09-28
**Status:** Blocked. Phase 3 (the tab) has not been built.
**Spec:** [artist-patronage-spec.md](artist-patronage-spec.md) §3.2 and §4, "Saved cards".

## What has to be true before building the tab

The tab keeps one card per fan, saved as a Customer and PaymentMethod on **Unstream's platform
account**. On the charge date, the card is **cloned** to each artist's Standard connected account and
charged there as a direct charge, off-session. If that doesn't work, the only other ways to charge a saved
card go through Unstream's own balance. That is the wrong side of the line in spec §2, so the tab doesn't
get built at all. There is no fallback design.

The build brief required checking this in Stripe test mode before writing any Phase 3 code.

## Why it wasn't verified

The session that built Phases 1 and 2 had no way to reach Stripe:

- There were no Stripe keys in its environment, test or live.
- Its network proxy refused `api.stripe.com` with a 403.

So this is **unverified**, not failed. Nothing was learned about Stripe's behaviour either way, and no
Phase 3 code, tables or workflow were written.

## How to run the check (about five minutes)

1. In the Stripe dashboard, switch to **test mode**. Copy the test secret key (`sk_test_…`).
2. Get a test-mode Standard connected account with charges enabled. The easiest way is to use the
   feature itself:
   - set `STRIPE_SECRET_KEY` to the test key in Netlify's dev context;
   - run `npm run dev`;
   - on `/dashboard`, press **Connect Stripe** on your own claimed profile;
   - complete Stripe's test onboarding. The test data is accepted, e.g. phone `000 000 0000`, SSN
     `0000`, and routing `110000000` with account `000123456789`.

   The account id (`acct_…`) then appears on `/admin/verify`.
3. Run:

   ```bash
   STRIPE_SECRET_KEY=sk_test_… npx tsx scripts/stripe-verify-clone.ts acct_…
   ```

   The script refuses anything but an `sk_test_` key and touches no database. It prints a results table.
   Paste the table below.

## What the script answers

| # | Question | What it means for Phase 3 |
|---|---|---|
| 1 | Does cloning a platform PaymentMethod to a Standard account work, and does it charge **off-session as a direct charge**? | **No:** Phase 3 stays stopped. **Yes:** go ahead. |
| 2a | Can the same clone be charged a second time with no Customer on the connected account? | Expected **no**: a PaymentMethod that isn't attached to a Customer is single-use. |
| 2b | Can a fresh clone be charged each time? | **Yes:** each monthly run clones afresh and **no extra table is needed**. That's the simplest option. |
| 2c | Can a clone attached to a Customer on the connected account be charged repeatedly? | **Yes:** the alternative is a `fan_connected_customers (user_id, artist_id, stripe_customer_id)` table. It's only worth it if 2b fails. |
| 3 | What does a card that needs authentication (SCA) return off-session? | Expected `authentication_required`. That confirms the spec's SCA fallback: email the fan a link to hosted Checkout on the artist's account. |

## Results

_Not run yet._

| Check | Outcome |
|---|---|
| | |

## Phase 3 once the gate passes

Build it as spec §10 phase 3 describes, and in this order:

1. The consent text and the privacy policy line on saved cards.
2. `fan_payment_accounts` and `recurring_support`, plus the `period` column and the
   `unique (fan_user_id, artist_id, period)` constraint on `tip_payments`. Add `'scheduled'` to its
   `channel` check and `'quick_tip'` / `'recurring'` to `support_entries.source`.
3. `me-support`, `me-support-card`, `support-charge-run` and `.github/workflows/support-charge-run.yml`.
4. The native Mac quick-tip sheet.

Phase 2's `support_entries` ledger and `tip_payments` already follow the spec's shapes, so the tab adds to
them without reworking anything.
