---
status: In progress
---
# Support page — spec

**Written:** 2026-09-26
**Status:** Built on `claude/support-page-stripe` (PR #536).
**Supersedes:** [open-books-membership-spec.md](open-books-membership-spec.md). The membership (sign-in,
a `memberships` table, a webhook, a separate public page, perks) was built, then dropped in PR #535 as
more machinery than the ask needs.

---

## 1. The ask

`/support` says three things plainly, in Brandon's voice:

1. He builds Unstream in his spare time and has been able to run it basically for free.
2. It's growing and outgrowing free services. Here's roughly what the paid versions cost: the
   database, caching & performance optimization, and the Apple Developer Program. Vendors aren't
   named (2026-09-26), because Brandon is exploring alternatives. Netlify is left off, because
   Brandon manages that cost by deploying less.
3. How to help: one Ko-fi button for one-off or monthly contributions, plus the existing non-money
   ways (star, share, report bugs).

There's no separate page, no member count, no perks and no accounts. The core product stays free,
and the page says so.

## 2. Decisions

| | |
|---|---|
| **Where money goes** | **Ko-fi** (`ko-fi.com/bgreenlol`), Brandon's personal page. Chosen 2026-09-26 over Stripe Payment Links, Lemon Squeezy and Buy Me a Coffee: Ko-fi takes no cut of tips, handles one-off and monthly giving, receipts and cancellations, supports PayPal, and is widely recognised. There is less to run than any of the alternatives. |
| **Presentation** | One prominent button, not tiered cards. |
| **Liberapay** | Removed from the page. Existing patrons can keep giving there; Brandon can tell them about Ko-fi directly. |
| **Perks** | None, deliberately. A pass or VIP framing was considered and dropped: perks are upkeep, "pass" implies access the free product already gives, and perks would turn support into a sale (sales tax, VAT). |
| **Tax** | A voluntary contribution with nothing in return is likely outside sales tax and VAT, but it is income to Brandon. To be confirmed with an accountant once. |
| **Mac app** | The macOS support link points at `/support`, from the next Mac release. The iOS StoreKit tip jar is unchanged (App Review 3.1.1). |
| **Backend** | None. `apps/web/src/data/support.ts` holds the Ko-fi URL and the cost list. |

## 3. Open questions for Brandon

1. **The cost figures** in `support.ts` are rough (database ~$25–30, caching a few dollars, Apple
   ~$8). Check them before this ships, since the page makes a claim about them.
2. **PayPal on the button caption.** The caption says "One-time or monthly". If PayPal is connected
   on Ko-fi, add "Cards and PayPal", which matters for international supporters.

## 4. Repo touchpoints

| Concern | Where |
|---|---|
| Page | `apps/web/src/pages/SupportPage.tsx` |
| Ko-fi URL, costs | `apps/web/src/data/support.ts` |
| Test | `apps/web/tests/unit/support-page-data.test.ts` |
| Mac | `apps/mac/Unstream/Views/Shared/TipJarView.swift` (macOS branch only) |
