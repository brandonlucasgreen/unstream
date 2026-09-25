---
status: Idea
---
# Open Books Membership — spec

**Written:** 2026-09-25
**Status:** Draft. Brandon answered the pricing, sign-in and Liberapay questions on 2026-09-25 (§10);
the rest of §10 is still open.
**Replaces:** the Liberapay button on `/support` and in the Mac app.
**Companion:** [artist-tips-spec.md](artist-tips-spec.md) — shares the payments decision in §3.
**Changes:** the paid Mac gate in [mac-app-premium-spec.md](mac-app-premium-spec.md) and
[support-loop-spec.md](support-loop-spec.md) Step 6 becomes a member perk (§6).

---

## 1. The bet

Unstream should pay for itself, or make Brandon a little money. Not scale, not raise.

It is currently free-tier everywhere, and the free tiers are what is breaking:

- **Supabase Nano** wedged on 2026-09-19 — PostgREST up but not answering for hours
  (`supabase-disk-io-investigation.md`, round 6). Six rounds of cutting writes have been spent
  staying inside a 0.5 GB instance.
- **Upstash** ran out of its 500K monthly commands in August 2026.
- **Netlify** Deploy Previews were switched off (#451) because they ate the build allowance.

So a membership isn't abstract "support the developer" money. It buys specific, nameable things:
a database that doesn't fall over, previews back, room to stop optimising for the free tier. The
bet is that saying exactly that, with the numbers public, converts better than a tip jar — and
that ~20–30 people will pay a few dollars a month for it.

**The framing is low-stakes and altruistic.** Nothing core is ever gated. Members get a few
thank-you perks and the satisfaction of seeing the bill covered. The Open Books page is the
product; the perks are a receipt.

---

## 2. Is there enough demand? The arithmetic

| | |
|---|---|
| Monthly cost off the free tiers | ~$40–60 (§5 line items — verify each before publishing) |
| Members at $3/mo to cover it, after fees | ~16–24 |
| Conversion benchmark (Overcast, goodwill-only) | ~1.9% of users; plan on 1–2% |
| Active users needed at 1.5% | ~1,100–1,600 |

**The honest problem:** the engaged cohort is artists, not fans. The Sept sweep logs show 134
claimed artists against 69 artists saved by *any* fan; Brandon: "very few non-musicians are using
this." So the realistic first members are **claimed artists** — people who already have accounts,
already get value (profile, analytics, release pages) and understand indie economics firsthand.
That shapes three decisions below: sign-in required (§4), the ask shown in the artist dashboard
(§7), and perks that artists care about, not just fans (§6).

If 134 claimed artists convert at 10–15% — plausible for a cohort that benefits directly — that
alone is 13–20 members. Coverage is reachable; profit is a stretch goal, not the plan.

---

## 3. Payments: the shared decision (both specs)

### Decision: one Stripe account, two products

**Brandon's single Stripe account is both:**

1. the **seller** of the membership, sold through **Stripe Managed Payments** — Stripe is the
   merchant of record, so Stripe (not Brandon) owes and files EU/UK VAT and US sales tax,
   including Massachusetts' 6.25% on SaaS; and
2. the **Connect platform** for tips — Standard accounts, direct charges, where the *artist* is
   merchant of record and Unstream never holds the money. Detail in
   [artist-tips-spec.md §3](artist-tips-spec.md#3-payments).

One account means one dashboard, one webhook-signing setup, one set of API keys, one payout to
Brandon, one place to read "what did Unstream earn this month" for the Open Books page.

**Fallback if Stripe says the two can't share an account** (or Managed Payments won't take a
membership, or isn't open to a US sole proprietor): membership on **Lemon Squeezy** (Stripe-owned,
still taking signups as of mid-2026, same MoR model), tips stay on Stripe Connect. Two dashboards,
same shape of code — the membership webhook handler is the only piece that differs.

### Why a merchant of record, and why this one

A membership with perks is a digital service. Sold directly, Brandon personally owes VAT in every
EU country and the UK from the first sale (no threshold for non-EU sellers of digital services),
plus US state sales tax where it applies — MA taxes SaaS. Stripe Tax *calculates* it; registering
and filing is still on him. For a one-person side project that's the wrong trade.

Fees per charge (**figures from search snippets 2026-09-25; the proxy blocked the pricing pages —
re-check before choosing prices**):

| | $3 monthly | $25 annual | $100 lifetime |
|---|---|---|---|
| Stripe Billing, direct (2.9% + 30¢, + 0.7% Billing on subscriptions) — *Brandon owes the tax* | 41¢ · 13.6% | $1.20 · 4.8% | $3.20 · 3.2% |
| **Stripe Managed Payments** (≈ 2.9% + 30¢ + 3.5%) | **49¢ · 16.4%** | **$1.90 · 7.6%** | **$6.70 · 6.7%** |
| Lemon Squeezy (5% + 50¢, before international/PayPal surcharges) | 65¢ · 21.7% | $1.75 · 7.0% | $5.50 · 5.5% |
| Paddle (5% + 50¢) | 65¢ · 21.7% | $1.75 · 7.0% | $5.50 · 5.5% |

- **Managed Payments wins at the price points that matter** because its fixed fee is 30¢, not 50¢,
  and it's the same Stripe account as tips. Lemon Squeezy edges it only on annual and lifetime.
- **The MoR premium over going direct is ~3 points** — about 8¢ on a $3 charge. That's the cost of
  never filing a VAT return. Worth it.
- **The fixed fee is the real enemy, not the percentage.** Monthly $3 loses ~16%; annual loses ~8%.
- **But annual earns less per member.** $25/yr is a 31% discount on 12 × $3: net ~$23.10 a year
  against ~$30.10 for a year of monthly. Leading with annual trades revenue for retention and fewer
  failed-card churn events. Brandon chose $25 (2026-09-25); the page shows both and doesn't push
  either. Coverage maths in §2 assumes a mix — ~20 members if all monthly, ~27 if all annual.

### The Liberapay tension

Liberapay takes 0% (it runs on its own donations; card processing still applies). Anything replacing
it is visibly more expensive per dollar. Don't hide that — the Open Books page shows payment
processing as its own cost line, so a member can see exactly what Stripe kept. Transparency is the
point of the page; it has to apply to the page's own plumbing.

### Framing constraint from the rails

Merchants of record sell products; they don't process donations. The thing sold is a
**membership** with perks, not a donation, and copy must say so — "Become a member", not "Donate".
The altruism lives in the Open Books framing, not in the payment category.

---

## 4. Decisions

| | |
|---|---|
| **Rails** | Stripe Managed Payments via hosted Checkout; Lemon Squeezy fallback (§3). |
| **Sign-in** | **Required before checkout** (Brandon, 2026-09-25). Checkout carries `client_reference_id = user_id`, so there's no email-matching or "claim your membership" flow to build, and Unstream never stores a buyer's email. Magic-link sign-in is one email round trip. The likely first members (claimed artists) already have accounts. |
| **Checkout** | Hosted Stripe Checkout redirect, hosted Customer Portal for cancel/update. No Stripe.js, so **no CSP change** — a top-level navigation to `checkout.stripe.com` isn't governed by `connect-src`/`script-src`. |
| **Tiers** | **$3/mo · $25/yr · $100 lifetime** (Brandon, 2026-09-25; lifetime follows Subvert's precedent). Both recurring options shown side by side. |
| **Core stays free** | Search, now-playing, support links, saved artists, release alerts, collections, the public API free tier. A perk may never be something an unpaid user used to have. |
| **Mac verification** | **Account, not licence key.** The Mac app already signs in (`AuthService.swift`, `SavedArtistsSync.swift`); it asks `GET /api/me/membership` and caches the answer. No licence server, no key to lose. §8. |
| **iOS** | Not offered in-app. The iOS StoreKit tip jar stays exactly as it is (`TipJarView.swift`, App Review 3.1.1). No iOS perks exist, so there's nothing to unlock and no IAP to build. §10 Q1. |
| **Liberapay** | **Six-month wind-down** (Brandon, 2026-09-25). §9. |
| **Grandfathering** | Manual. Liberapay patrons and StoreKit tippers get a `grandfathered` membership granted by an admin script on request. §9. |
| **Open Books data** | Costs: a JSON file in `data/` Brandon edits monthly. Revenue: live aggregates from the webhook-maintained `memberships` table, plus a hand-closed monthly ledger. §5. |
| **Surplus** | Goes to Brandon, and the page says so in those words. |

---

## 5. The Open Books page

Route `/open-books`, linked from `/support`, the footer and every membership ask. SPA page, like
`SupportPage.tsx`; no edge renderer (one route, one renderer).

### What it shows

1. **This month's bill** — line items with what each buys, e.g.
   "Supabase Pro — $25 — the database; the free tier went down for hours on Sept 19."
2. **What members cover** — active member count, monthly-normalised revenue (annual ÷ 12), and a
   coverage bar: `revenue ÷ costs`, capped visually at 100% with the surplus shown beside it.
3. **Where the surplus goes** — one sentence: to Brandon, who builds this on evenings and weekends.
   No reserve fund theatre unless Brandon wants one (§10 Q4).
4. **Past months** — the closed ledger: actual costs, actual fees, actual net.
5. **Other income** — Unstream's tip-fee income once [tips](artist-tips-spec.md) exist; Liberapay
   receipts while it's still live (they're public on Liberapay anyway); iOS tip-jar income net of
   Apple's cut.

**Aggregate only.** No names, no handles, no per-member amounts — not even opt-in in v1. A member
count below 5 is shown as "fewer than 5" so a single member's payment can't be inferred from the
revenue line.

### Data

**Costs and closed months — `data/open-books/ledger.json`**, edited by hand once a month:

```json
{
  "currency": "USD",
  "costs": [
    { "item": "Supabase Pro", "monthly": 25, "why": "The database. The free tier wedged on 2026-09-19." }
  ],
  "months": [
    { "month": "2026-11", "costs": 52.10, "processingFees": 6.40, "memberRevenue": 61.00,
      "tipFeeRevenue": 0, "otherRevenue": 4.00 }
  ]
}
```

Served from `/data/**` like guides and the changelog. `data/` is deliberately not in
`netlify-ignore-build.sh`'s skip list, so editing it deploys.

**Live figures — `GET /api/open-books`** returns `{ activeMembers, monthlyRevenue, byPlan }`
computed from `memberships` at request time. **No Redis**: a `Cache-Control: public,
s-maxage=3600` header lets Netlify's CDN absorb it, which costs zero Upstash commands. The page
labels these as "live, updated hourly" and the ledger as "closed" so the two can never be confused.

### Costs to list (verify every figure before publishing — these are leads from search snippets)

| Item | Monthly | Note |
|---|---|---|
| Supabase Pro | $25 | Includes $10 compute credit, which covers Micro |
| Supabase compute Small | +$5 | Only if Micro isn't enough; decide from the round-6 memory graphs |
| Netlify Personal / Pro | $9 / $20 | Personal likely suffices; Pro if previews come back (#451) |
| Upstash pay-as-you-go | ~$1–5 | $0.20 per 100K commands at current volume |
| Apple Developer Program | $8.25 | $99/yr — needed for notarisation and the iOS app |
| Domain `unstream.stream` | ~$3 | Annual renewal ÷ 12 |
| Cloudflare / Resend / Buttondown / Sentry | $0 today | List them at $0 — showing what's free is part of the honesty |
| Lawyer review, LLC | one-off | Shown in the month paid, not amortised — see tips spec |

---

## 6. Perks

Thank-you perks, never gates on anything core. In order of how cheap they are:

| Perk | Who it's for | Cost to build |
|---|---|---|
| **Member badge** on `/u/:handle` and on a claimed artist's page | Fans and artists | Small — a boolean the edge renderers already have the join for |
| **Early betas** — TestFlight/Sparkle beta channel, extension betas | Enthusiasts | Near zero — a Sparkle beta appcast gated on membership |
| **Roadmap vote** — a short list Brandon picks, one vote per member per quarter | Everyone | Small; could start as a Discord role instead |
| **Mac premium features** as they ship — Support List, Shortcuts, widget, export | Mac users | Already specced in `mac-app-premium-spec.md`; the gate is this membership |

### What changes for the Mac premium plan

`mac-app-premium-spec.md` planned a ~$15 one-time paid SKU via Paddle/Lemon Squeezy, and
`support-loop-spec.md` Step 6 a "paid gate + licence check". **Both become: the features are member
perks, verified by account** (§8). No separate SKU, no licence keys. A $100 lifetime membership is
the one-time-purchase option for people who hated subscriptions — it covers the same buyer the
$15 SKU was for, at a price that reflects that it also funds the servers.

Trade-off, stated plainly: the indie-Mac audience prefers one-time purchases and a licence key
works without an account. A member-perk model asks Mac users to sign in. The Mac app already has
sign-in for saved-artist sync, and local-only listening history can stay local — the account
proves membership, it doesn't upload anything. §10 Q2.

---

## 7. The ask

At moments of value, dismissible, never nagging.

| Moment | Surface | Copy direction |
|---|---|---|
| After a click-out on a Bandcamp Friday | Web results, Mac popover | "You just sent money to an artist. Unstream costs $52 a month to run — here's the bill." |
| Footer of the release-alert email | Email | One line + Open Books link. Never the subject, never above the release. |
| After the extension detects an artist | Extension popup | Only after the 10th detection, once. |
| Artist dashboard | Web | A quiet card: "Unstream is run by one musician. Here's what it costs." |
| `/support` | Web | The main surface. Replaces the Liberapay button. |

**Rules:**
- Never shown to members.
- Dismiss hides that surface's ask for 90 days; a "don't ask again" hides it for good. Stored on
  the account when signed in, in `localStorage` otherwise (try/catch; a throwing storage just
  means the ask shows).
- At most one ask per user per 30 days across all surfaces.
- Every ask links to Open Books first, checkout second. The numbers do the persuading.
- Never in search results themselves, never before the support links, never in a blocking modal.

---

## 8. Architecture

### Data model — one table

`supabase/migrations/YYYYMMDDHHMMSS_memberships.sql`:

```
memberships
  user_id               uuid primary key            -- auth.users(id), on delete cascade
  plan                  text  check (plan in ('monthly','annual','lifetime','grandfathered'))
  status                text  check (status in ('active','past_due','canceled'))
  stripe_customer_id    text  unique null            -- null for grandfathered
  stripe_subscription_id text unique null            -- null for lifetime/grandfathered
  amount_cents          integer null                 -- what they pay per period, for aggregates
  currency              text  null
  current_period_end    timestamptz null             -- null = doesn't expire
  started_at            timestamptz not null default now()
  canceled_at           timestamptz null
  updated_at            timestamptz not null default now()
```

- **Server-only: RLS enabled, no policies**, with a comment saying that's deliberate. Every read
  goes through a function using the service role. Users read their own status via
  `/api/me/membership`; nobody reads anyone else's except as the aggregate and the badge boolean.
- No email, no name, no card data. Stripe holds those.
- One row per user — you're a member or you aren't. Plan changes update the row.
- A `stripe_events` idempotency table is **not** needed: every webhook handler is an upsert keyed
  on `user_id` that sets absolute state from the event's object, so replays are harmless.

### Functions

| Function | Route | Auth | Notes |
|---|---|---|---|
| `me-membership.ts` | `GET /api/me/membership` | Bearer | `{ active, plan, currentPeriodEnd }`. Follows the `me-*` pattern: added to `api/tsconfig.json`'s include, test in `__tests__/`. `account` rate limit. |
| `membership-checkout.ts` | `POST /api/membership/checkout` | Bearer | `{ plan }` → creates a Checkout Session (`mode: subscription` or `payment` for lifetime, `client_reference_id: userId`, success/cancel back to `/open-books`) → `{ url }`. Refuses if already active. Typecheck include + test. `account` rate limit. |
| `membership-portal.ts` | `POST /api/membership/portal` | Bearer | Customer Portal session → `{ url }`. Typecheck include + test. |
| `membership-webhook.ts` | `POST /api/membership/webhook` | Stripe signature | See below. Typecheck include + test. **No rate limiter** — the signature is the auth, and it saves Redis commands. |
| `open-books.ts` | `GET /api/open-books` | Public | Aggregates, CDN-cached (§5). |

### Webhook

- Verify with `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_MEMBERSHIP_WEBHOOK_SECRET)`.
  **On Netlify, decode `event.body` from base64 when `event.isBase64Encoded`** before verifying,
  or every signature fails. Reject unsigned or stale events with 400.
- Handle: `checkout.session.completed` (create/activate; lifetime lands here), `customer.subscription.updated`
  and `.deleted` (status, period end), `invoice.payment_failed` (→ `past_due`). Ignore the rest
  with a 200.
- Keep 7 days of grace on `past_due` before perks switch off — Stripe retries cards; don't punish a
  lapsed card on day one.
- **Never log the event body.** Log the event type and id only. Sentry breadcrumbs likewise.
- If a `client_reference_id` doesn't match a user (deleted account mid-checkout), report to Sentry
  and 200 — a 500 makes Stripe retry for days against something that can't succeed.

### Outbound calls and secrets

- Add `api.stripe.com` to `ALLOWED_OUTBOUND_HOSTNAMES` with a comment on what calls it. The
  `stripe` Node SDK does its own networking; construct it with
  `httpClient: Stripe.createFetchHttpClient(...)` over a fetch that checks `isUrlHostnameAllowed`
  so it can't be the one outbound path that skips the allowlist.
- New Netlify env vars: `STRIPE_SECRET_KEY` (restricted key, only the permissions these functions
  use), `STRIPE_MEMBERSHIP_WEBHOOK_SECRET`, price IDs as `STRIPE_PRICE_MONTHLY` / `_ANNUAL` /
  `_LIFETIME`. **Delete, don't blank**, in `.env` — the empty-value shadow (CLAUDE.md, "Local dev").
- `stripe` goes in the root `package.json`, never imported by `apps/web`.

### Local testing

`npm run dev` talks to **production** Supabase, so a test checkout would write a real
`memberships` row. Use Stripe **test mode** keys locally (live keys only in the Netlify production
context), `stripe listen --forward-to localhost:8888/api/membership/webhook`, and a throwaway
account — then delete its row. Say this in the function's header comment.

### Mac entitlement

- `GET /api/me/membership` on launch and every 24h; cache `{ active, validUntil }` in the Keychain
  where `validUntil = currentPeriodEnd + 7 days` (or far future for lifetime/grandfathered).
- Offline: trust the cache until `validUntil`. The sandboxed app already makes network calls, so
  no new entitlements.
- Signed out: premium features show what they do and a "Members get this" link to Open Books.
  Never a nag badge on the menu bar icon.
- `TipJarView.swift` macOS branch: Liberapay link → "Become a member" link to `/open-books`. The
  iOS branch doesn't change.

---

## 9. Migration from Liberapay and the tip jar

- **Liberapay:** retire the button on `/support` and in the Mac app; keep a small "Already give on
  Liberapay? That still counts" line linking to it for six months, and count Liberapay receipts on
  Open Books meanwhile. Brandon messages current patrons once with the Open Books link and an offer
  of a grandfathered membership. Then close it. (Decided 2026-09-25.)
- **iOS StoreKit tippers:** consumable purchases carry no identity Unstream can check, so there's no
  automatic path. A line in the iOS settings screen — "Tipped before? Email and I'll add member
  perks to your account" — and Brandon grants on the honour system. At this scale, honour is fine.
- **Granting:** `scripts/grant-membership.ts <email>` looks up the auth user by email and upserts a
  `grandfathered` row. Service-role, run locally by Brandon; no admin UI for a handful of rows.

---

## 10. Open questions for Brandon

**Decided 2026-09-25:**

- **Sign-in required** to become a member (§4).
- **$3/mo · $25/yr · $100 lifetime** (§3, §4).
- **Liberapay: six-month wind-down** (§9).

**Still blocking — answer before any build:**

1. **iOS: say nothing about membership in the iOS app?** Recommended yes. (The 2025 US ruling
   against Apple allows external purchase links in the US storefront only — not worth the review
   risk for an app that has no member-only features.)
2. **Mac premium: confirm perks-for-members replaces the ~$15 one-time SKU**, accepting sign-in as
   the price of it (§6).

**Before launch, not before build:**

3. **Stripe confirmation** (shared with tips — one conversation): does Managed Payments accept a
   supporter membership with perks, for a US sole proprietor, on the same account as a Connect
   platform? If any answer is no, the Lemon Squeezy fallback applies.
4. **Surplus policy.** "It goes to me" is the honest default. Anything more (a 3-month reserve
   first, a share to artists) is optional and Brandon's call.
5. **Is the artist dashboard an acceptable place to ask?** Artists first says be careful; they're
   also the likeliest members. Recommended: one quiet card, dismissible, never above their analytics.
6. **LLC.** Doesn't change the membership analysis (Stripe is MoR). Relevant to tips; see that spec.

---

## 11. Phasing

Smallest shippable first. Membership lands before tips because it's the revenue and has no legal
gate — Stripe is merchant of record.

1. **Open Books page, costs only.** `ledger.json` + `/open-books`, linked from `/support`. No
   payments. Tests whether the numbers read well, and it's the honest precondition for asking. Can
   ship the week the answers come in.
2. **Membership on the web.** Migration, the five functions, checkout from `/open-books` and
   `/support`, Customer Portal, badge on `/u/:handle`. Liberapay wind-down starts (§9).
3. **Mac entitlement + beta channel.** `/api/me/membership` in the Mac app, member-gated Sparkle
   beta appcast, `TipJarView` macOS link swap. Grandfather grants.
4. **The asks** (§7), one surface at a time, starting with `/support` and the release-alert footer.
5. **Mac premium features as perks**, as each ships per `support-loop-spec.md`.
6. **Tip-fee income on Open Books** — once [tips](artist-tips-spec.md) exist.

---

## 12. Repo touchpoints

| Concern | Where |
|---|---|
| Migration | `supabase/migrations/YYYYMMDDHHMMSS_memberships.sql` — RLS on, no policies, comment why |
| Functions | `api/functions/me-membership.ts`, `membership-checkout.ts`, `membership-portal.ts`, `membership-webhook.ts`, `open-books.ts` |
| Typecheck + tests | `api/tsconfig.json` `include`; `api/functions/__tests__/` — webhook signature, base64 body, replay idempotency, unknown user |
| Routes | `netlify.toml` `[[redirects]]` for `/api/membership/*`, `/api/me/membership`, `/api/open-books` — before the SPA catch-all |
| CSP | **No change** — hosted Checkout and Portal are navigations |
| SSRF | `api/functions/middleware.ts` `ALLOWED_OUTBOUND_HOSTNAMES` += `api.stripe.com` |
| Ledger | `data/open-books/ledger.json` |
| Pages | `apps/web/src/pages/OpenBooksPage.tsx` (new, lazy in `main.tsx`); `SupportPage.tsx` (Liberapay → membership) |
| Badge | `api/edge/u-handle.ts`, `api/functions/public-saved-artists.ts`; artist badge in `api/edge/artist-page-static.ts` |
| Mac | `apps/mac/Unstream/Views/Shared/TipJarView.swift` (macOS branch only), `Services/AuthService.swift` neighbour for entitlement |
| Grants | `scripts/grant-membership.ts` |
| Copy | `README.md` "All apps are free with no paywall" → "Core features are free for good; members get a few thank-you perks." |
| Changelog | `data/shipped-features.json` per phase |
