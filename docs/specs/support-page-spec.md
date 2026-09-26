---
status: In progress
---
# Support page — spec

**Written:** 2026-09-26
**Status:** Built on `claude/support-page-stripe`. It goes live once the three Stripe Payment Links exist (§4).
**Supersedes:** [open-books-membership-spec.md](open-books-membership-spec.md). The membership (sign-in,
a `memberships` table, a webhook, a separate public page, perks) was built, then dropped in PR #535 as
more machinery than the ask needs. Brandon: simpler, but just as effective.

---

## 1. The ask

`/support` says three things plainly, in Brandon's voice:

1. Unstream runs on his own time, and so far on free tiers.
2. That's about to change. Here are the services it's outgrowing, roughly what they'll cost, and
   the Apple fee already being paid.
3. How to help: three Stripe options, plus the existing non-money ways (star, share, report bugs).

There's no separate page, no member count, no perks and no accounts. The core product stays free,
and the page says so.

## 2. Decisions

| | |
|---|---|
| **Options** | $3 a month · $25 a year · one-off, **pay what you want**, with a $3 minimum. |
| **Mechanism** | **Stripe Payment Links**, made in the dashboard. No backend, no webhook, no table, no new env vars, no CSP change: each option is a plain link to `buy.stripe.com`. |
| **Pay what you want** | A Payment Link option: "let customers choose what to pay", with a suggested amount ($10) and a $3 minimum, so the 30¢ fixed fee never eats more than ~13%. |
| **Managing a recurring payment** | Stripe's hosted customer-portal login link (`billing.stripe.com/p/login/...`). Supporters sign in by email, and Unstream stores nothing. |
| **Sign-in** | Not needed. Nothing is linked to an Unstream account. |
| **Merchant of record** | Not used (Q1). With no perks this is support given to Brandon, not a digital product sold, so plain Stripe has the lowest fees (2.9% + 30¢), and there's no MoR product to qualify for. |
| **Liberapay** | Wind-down. Until all three links exist it stays the working button; after that it's one line ("Already give on Liberapay? That still counts") until about March 2027. |
| **Mac app** | The macOS support link points at `/support` instead of Liberapay, from the next Mac release. The iOS StoreKit tip jar is unchanged (App Review 3.1.1). |
| **Tips** | [artist-tips-spec.md](artist-tips-spec.md) is unaffected. Its shared-Stripe-account note now just means "the same Stripe account". |

## 3. Why Payment Links rather than code

Every piece of the dropped membership existed to answer "is this person a member?": the table,
the webhook, sign-in, the portal endpoint. With no perks, nothing asks that question. Payment Links
cover checkout, receipts, subscriptions, pay-what-you-want and the customer portal, and they're
hosted by Stripe. The whole integration is three URLs in `apps/web/src/data/support.ts`.

What it costs: there's no live "N supporters, $X a month" figure on the page. Stripe's dashboard has
it, and if a public number is wanted later, a hand-edited line in `support.ts` is the boring way.

## 4. Going live

1. In Stripe, create one product ("Support Unstream") with three Payment Links:
   - $3/month recurring.
   - $25/year recurring.
   - One-time, customer chooses price: suggested $10, minimum $3.
   Set each link's confirmation page to `https://unstream.stream/support`.
2. Turn on the customer portal and copy its login link.
3. Paste the four URLs into `apps/web/src/data/support.ts`. The test pins them to `buy.stripe.com` and
   `billing.stripe.com`.
4. Merge. Liberapay drops to its wind-down line automatically once all three links are set.

## 5. Open questions for Brandon

1. **Merchant of record, or plain Stripe?** Recommended: plain Stripe, as above. The caveat is that
   whether no-perk support to an individual owes VAT or sales tax anywhere is a question for an
   accountant, not code. If the answer is "treat it as a sale", switch the links to Managed Payments
   in the dashboard; nothing in the repo changes.
2. **The cost figures** in `support.ts` are rough (Supabase ~$25–30, Netlify ~$9–20, Upstash a few
   dollars). Check them before this ships, since the page makes a claim about them.

## 6. Repo touchpoints

| Concern | Where |
|---|---|
| Page | `apps/web/src/pages/SupportPage.tsx` |
| Options, costs, links | `apps/web/src/data/support.ts` |
| Test | `apps/web/tests/unit/support-options.test.ts` |
| Mac | `apps/mac/Unstream/Views/Shared/TipJarView.swift` (macOS branch only) |
