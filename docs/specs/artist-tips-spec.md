---
status: Idea
---
# Artist tips — spec

**Written:** 2026-09-25
**Status:** Draft. Gated on a Stripe policy confirmation and a lawyer review (§5) before any build,
and phased after [open-books-membership-spec.md](open-books-membership-spec.md).
**Supersedes:** [patronage-spec.md](patronage-spec.md) — its Stripe structure (Express + destination
charges) and migration naming (`migration-006`) are both wrong now. Its UI inventory is still a
useful checklist.
**Not:** the group pass in [unstream-patronage.md](unstream-patronage.md), which stays parked.

---

## 1. The bet — and whether to make it

A fan pays a claimed, verified artist a one-off amount through Unstream, at the moment they're
listening. The money goes straight to the artist's own Stripe account. Unstream optionally keeps a
small, visible cut.

**Be honest about the zero-build alternative first.** Artists can already list Ko-fi, Buy Me a
Coffee, Patreon and Liberapay links; they render in the patronage category today. Ko-fi takes 0% on
tips. So a native tip is **not** cheaper than what exists, and it is **not a revenue source** for
Unstream: at 5% on, say, 20 tips a month averaging $8, Unstream earns $8 a month. The membership is
the revenue plan; this is not.

What a native tip does that a Ko-fi link can't:

1. **In context at the listening moment.** The Mac popover and the extension already know what's
   playing. "Tip $5" in the popover, without opening a browser tab to someone else's site and
   making an account there, is the one thing no link can do. It's the mission moment the Mac
   premium spec is built around.
2. **Zero setup beyond Stripe for the artist.** No new profile on another platform to maintain;
   their claimed Unstream profile *is* the tip page.
3. **It closes the support loop.** A tip can mark the artist "supported" / `patron` for a signed-in
   fan — the state `mac-app-premium-spec.md` reserved for "Unstream patronage once it ships."
4. **Fee transparency Unstream controls.** The fan sees the exact split before paying.

**Recommendation: don't build it yet — test the demand with what exists first (Phase 0, §9).**
Surface the artist's *existing* patronage links at the listening moment in the Mac popover and the
extension, and count click-outs. If people click Ko-fi links from the popover, a one-tap native tip
will do better and is worth building. If nobody clicks, a native button won't change that, and the
lawyer's fee is saved. With 69 artists saved by any fan (Sept sweep), the likeliest outcome is
"not yet" — which is fine, and cheap to learn.

---

## 2. Decisions

| | |
|---|---|
| **Eligibility** | Claimed **and** verified artists only (`artist_profiles.verified_at is not null`), who have connected Stripe and switched tips on. Nobody else ever shows a tip button. |
| **Payment structure** | Stripe Connect **Standard** accounts + **direct charges** + `application_fee_amount` (§3). |
| **Money handling** | Unstream never holds, pools, or transfers funds. The charge is created on the artist's account. |
| **Unstream's fee** | **Artist-chosen, 0–5%, default 0%.** Recommended — see Q1. Shown to the fan either way. |
| **Amounts** | Presets **$5 / $10 / $20**, custom allowed, **minimum $3**, maximum $500. §4. |
| **Fan covers fees** | Optional checkbox, **on by default** ("add $0.46 so {artist} gets the full $5"). Ampwall reports ~75% of buyers opt in. |
| **Fan sign-in** | Not required. If signed in, the tip is linked to the fan's account (privately) to mark the artist supported. §6. |
| **Fan message** | Not in v1 — it's a moderation surface. Stripe Checkout's email receipt is the thank-you. |
| **Refunds and disputes** | The artist's, in their own Stripe dashboard — they're merchant of record. Refunds return Unstream's fee (`refund_application_fee: true`). |
| **Currency** | Charged in USD in v1, presented in the fan's currency by Checkout where Stripe supports it. Multi-currency presets later if non-US artists sign up. |
| **Checkout** | Hosted Stripe Checkout on the artist's account. No Stripe.js, no CSP change. |
| **Platform account** | Shared with membership — see [membership spec §3](open-books-membership-spec.md#3-payments-the-shared-decision-both-specs). |

---

## 3. Payments

### Standard + direct charges, not Express + destination

| | Standard, direct charges (chosen) | Express, destination charges (old spec) |
|---|---|---|
| Merchant of record | **The artist** | Unstream, unless `on_behalf_of` |
| Negative balances, fraud losses | **Stripe** (`losses.payments: stripe`) | The platform |
| 1099-K / tax forms to artists | **Stripe files** | The platform |
| Connect fees to Unstream | **$0** — Stripe bills the artist's account directly | $2 per monthly active account + 0.25% + 25¢ per payout |
| Artist's dashboard | Full Stripe dashboard | Express dashboard |
| Onboarding friction | Higher — a full Stripe account | Lower |
| Unstream ever holds money | **No** | Briefly, yes |

Standard costs more onboarding friction and buys everything else: no liability for chargebacks, no
tax forms, no per-account fees, no funds held. For a one-person operation that's the whole ballgame.
Artists already on Stripe (Mirlo sellers, Ko-fi users) connect an existing account.

In current Stripe terms, create connected accounts with controller properties:
`controller.stripe_dashboard.type: full`, `controller.fees.payer: account`,
`controller.losses.payments: stripe`, `controller.requirement_collection: stripe`. Onboard with
Account Links (or OAuth for existing accounts).

**Out of scope:** separate charges and transfers — the pooled split — which is exactly what the
parked group pass needed and why it stays parked.

### Stripe's tips/donations policy — confirm before building

Stripe's restricted-business terms say "a tip must be given for a good or service provided" and
"you may not accept donations on behalf of someone other than yourself." With direct charges the
*artist* is the one accepting, for music they made, which should be fine. **Confirm in writing
with Stripe before writing code**, in the same conversation as the membership questions (membership
spec Q6). Frame the product as **support for an artist's music**, never as a donation or charity.

### Countries

Standard accounts exist only in Stripe-supported countries (~46). Direct charges on Standard
accounts don't have the cross-border restrictions destination charges do — **verify that too**.
An artist in an unsupported country:

- sees, in the dashboard: "Stripe isn't available in {country} yet, so Unstream tips can't reach
  you. Add a Ko-fi, Patreon or Liberapay link to your profile and fans will see it in the same
  place." — with a link to their profile editor;
- produces nothing visible to fans. No greyed-out button, no "not available" — just their existing
  links.

---

## 4. Money: fees and amounts

Stripe's standard US card pricing, 2.9% + 30¢ (**verify; international cards add ~1.5%, currency
conversion ~1%**), paid by the artist's account:

| Tip | Stripe fee | % lost | + Unstream 5% | Artist receives (5% fee) |
|---|---|---|---|---|
| $1 | 33¢ | 32.9% | 5¢ | $0.62 |
| $3 | 39¢ | 12.9% | 15¢ | $2.46 |
| **$5** | 45¢ | 8.9% | 25¢ | $4.30 |
| **$10** | 59¢ | 5.9% | 50¢ | $8.91 |
| **$20** | 88¢ | 4.4% | $1.00 | $18.12 |

- **Minimum $3.** Below it the fixed fee takes more than an eighth. $1 tips are a donation to Stripe.
- **Presets $5 / $10 / $20.** $5 is where the fee drops under a tenth.
- **"Cover the fees" grosses up** so the artist nets the chosen amount: at 0% Unstream fee, a $5 tip
  becomes `(5 + 0.30) / (1 − 0.029)` = **$5.46**. The server computes it; the client only displays it.
- **The breakdown is always shown before paying:** "You pay $5.46 · Stripe keeps $0.46 · Unstream
  keeps $0 · {Artist} gets $5.00". Transparency is a core value, and it's also what makes a 0%
  default visible as a choice.

### Unstream's fee (Q1)

Options, in order of recommendation:

1. **Artist-chosen 0–5%, default 0%.** Artists first; the artist decides whether to chip in, and the
   fan sees what they chose. Mirlo does artist-set fees (default higher, ~7–10%).
2. Fixed 0%. Simplest; also removes most of the tax question in §5. Revenue difference is a few
   dollars a month at any realistic volume.
3. Fixed ≤5%. Simplest to explain; worst on "artists first".

Not offered: a fan-added "tip Unstream too" line. On a direct charge that money would be the
artist's revenue with Unstream skimming it — which is what "donations on behalf of someone other
than yourself" prohibits. Fans who want to fund Unstream have the membership.

---

## 5. Legal and tax — pre-launch gates

**None of this is legal advice; it's the list for the lawyer.**

### Money transmission (Massachusetts)

M.G.L. c. 169B (Chapter 312 of the Acts of 2024, in force 2026-01-01) licenses money transmitters,
with an agent-of-the-payee exemption (written agreement with the payee, among other conditions).
Direct charges mean Unstream never receives, holds or transmits the funds — the strongest position
available. Still:

- **Gate: a scoped lawyer review before launch** — likely low four figures. Questions: does
  facilitating direct charges with an application fee fall outside c.169B entirely; does the artist
  agreement need agent-of-payee language anyway as belt and braces; anything for other states given
  artists and fans are everywhere.
- The review cost goes on the Open Books page in the month it's paid.

### Entity

An LLC (MA: $500 to form, $500 a year) shields personal assets from a claim against Unstream but
doesn't change the licensing analysis. Q3 — ask the lawyer whether the risk profile of direct
charges justifies it. The annual fee would also appear on Open Books.

### Tax

- **VAT/GST on the tip itself:** the artist's concern — they're merchant of record, like Ko-fi.
- **Unstream's application fee** is Brandon's income (Schedule C, or the LLC's). Whether MA's
  6.25% sales tax on SaaS reaches a platform fee charged to artists is **unresolved — for counsel**.
  A 0% default fee (Q1) makes it mostly moot.
- **DAC7 (EU) / UK platform reporting:** probably doesn't apply to pure tips (arguably no
  "consideration"), but EU/UK artists could trigger it. **Flag for counsel.**
- 1099-Ks to artists: Stripe files them (Standard accounts).

### Artist agreement

A short tips addendum accepted when an artist enables tips: they're the seller, refunds and
disputes are theirs, Unstream's fee (whatever they chose), Unstream can switch tips off for abuse.
Drafted or reviewed in the same lawyer engagement.

---

## 6. Fan experience

- **Where the button appears:** the artist page (`/a/:slug`, edge-rendered — see below), result
  cards for eligible artists, the Mac popover's now-playing card, the extension popup. It sits in
  the patronage category's position — it *is* a patronage option, ordered first because it pays
  the artist ~91–95%.
- **Flow:** amount sheet (presets, custom, cover-fees toggle, live breakdown) → server creates a
  Checkout Session on the artist's account → redirect → back to `/tip/thanks?artist={slug}` or the
  artist page on cancel.
- **Artist pages are edge-rendered** (`artist-page-static`). One route, one renderer: the edge
  function renders a plain link to `/tip/{slug}`, an SPA route that owns the amount sheet. The SPA
  never takes over the artist page to show a modal. Same pattern as `/u/:handle`'s Copy URL button.
- **Mac and extension** open `/tip/{slug}` in the browser — Checkout needs a real browser, and it
  keeps card entry out of the app. iOS shows no tip button at all (App Review 3.1.1; tipping a
  third party through an external link is a rejection risk and not worth testing).
- **Signed-in fans:** the session carries the fan's `user_id` in metadata. On success the webhook
  marks the artist supported in the fan's saved artists and, later, `patron` in the Support List.
  The link is private — never on `/u/:handle`, never in aggregates, never shown to the artist
  (they get what Stripe Checkout collected, which is the fan's email, from their own dashboard).

## 7. Artist experience

In the artist dashboard (`ArtistDashboardPage.tsx`), per claimed profile:

1. **Not connected** — explanation, the fee table in §4, "Connect Stripe" → Account Link.
2. **Onboarding incomplete** — "Stripe needs a few more details" → fresh Account Link.
3. **Connected, off** — settings: on/off, Unstream fee 0–5% (if Q1 goes that way), preview of what
   fans see.
4. **Connected, on** — totals this month and all time (count, gross, net) from the `tips` table,
  and a link to their Stripe dashboard for everything else. No transaction table in v1 — Stripe's
  dashboard is better at that and already theirs.

Unsupported country → the message in §3, instead of step 1.

---

## 8. Architecture

### Data model

`supabase/migrations/YYYYMMDDHHMMSS_artist-tips.sql`:

```
artist_tip_accounts                     -- one per claimed artist who has connected Stripe
  artist_id            uuid primary key references artists(id) on delete cascade
  stripe_account_id    text unique not null
  charges_enabled      boolean not null default false   -- mirrored from account.updated
  tips_enabled         boolean not null default false   -- the artist's switch
  fee_basis_points     integer not null default 0 check (fee_basis_points between 0 and 500)
  country              text null
  created_at, updated_at timestamptz

tips                                    -- one per successful charge
  id                   uuid primary key default gen_random_uuid()
  artist_id            uuid not null references artists(id)
  stripe_account_id    text not null
  stripe_charge_id     text unique not null            -- idempotency key for webhook replays
  amount_cents         integer not null                -- what the fan paid
  application_fee_cents integer not null
  currency             text not null
  fan_user_id          uuid null                        -- only if signed in; private
  status               text check (status in ('succeeded','refunded','disputed'))
  created_at           timestamptz not null default now()
```

- **Both server-only: RLS enabled, no policies**, with a comment saying so. The artist reads their
  totals and the fan's tip-to-supported link through service-role functions that check ownership.
- Public eligibility ("does this artist take tips") is a boolean joined into the artist page and
  search payloads server-side: `tips_enabled and charges_enabled and verified`.
- **No fan PII**: no email, no name, no card data. `fan_user_id` is the only link and it's nullable.
- Uniqueness on `stripe_charge_id` makes webhook replays no-ops.

### Functions

| Function | Route | Auth | Notes |
|---|---|---|---|
| `tips-connect.ts` | `POST /api/tips/connect` | Bearer + owns the claimed, verified profile | Creates the connected account if missing, returns an Account Link. `account` limit. |
| `tips-settings.ts` | `GET/PUT /api/tips/settings` | Bearer + ownership | Toggle, fee; `GET` also returns totals. |
| `tips-checkout.ts` | `POST /api/tips/checkout` | Public | `{ artistSlug, amountCents, coverFees }` → validates range, re-reads eligibility server-side, computes gross-up and application fee server-side, creates Checkout Session with `stripeAccount` header → `{ url }`. Rate-limited `strict` per IP (card-testing defence); Stripe Radar on the artist's account does the rest. |
| `tips-webhook.ts` | `POST /api/tips/webhook` | Stripe **Connect** webhook signature | Separate endpoint and secret from membership: Connect events arrive with an `account` field and a different signing secret. Handles `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`, `account.updated`. Base64-decode on Netlify before verifying. No rate limiter. |

All four join `api/tsconfig.json`'s include with tests in `__tests__/` — money endpoints don't get
to fail at runtime in production. Tests: amount bounds, fee maths (the §4 table as fixtures),
ownership checks, ineligible artist refused, signature failure, base64 body, replayed event.

### Security notes

- The client sends an amount; the **server** decides the fee, the gross-up and eligibility. Never
  trust a client-computed fee.
- Ownership is checked against `artist_profiles.user_id` and `verified_at` on every artist-side
  call, not just in the UI.
- `api.stripe.com` goes through the allowlist exactly as in the membership spec (§8 there).
- Never log amounts tied to a user, account ids alongside emails, or event bodies.
- Stripe test mode locally; live keys only in the production context. `npm run dev` writes
  production `tips` rows otherwise.

---

## 9. Phasing

After membership Phases 1–2. Each gate is a real gate.

0. **Demand test, no payments.** Show the artist's existing patronage links (Ko-fi, Patreon, etc.)
   on the Mac popover's now-playing card and the extension popup; count click-outs in existing
   analytics. Run through at least one Bandcamp Friday. **Go/no-go on the numbers.**
1. **Gates.** Stripe written confirmation (policy, countries, shared account). Lawyer review.
   Artist addendum drafted. LLC decision.
2. **Artist onboarding only.** Migration, `tips-connect`, `tips-settings`, `account.updated`
   webhook, dashboard states 1–3. Invite a handful of claimed artists to connect; no fan UI yet.
3. **Web tipping.** `tips-checkout`, `/tip/{slug}`, `/tip/thanks`, button on artist pages and result
   cards, webhook success/refund/dispute. Tip-fee income added to Open Books.
4. **Mac popover and extension.** The listening-moment button — the reason this exists.
5. **Support-loop integration.** Signed-in tips mark the artist supported / `patron`.

---

## 10. Open questions for Brandon

**Blocking — before Phase 0 is judged or anything is built:**

1. **Unstream's fee: artist-chosen 0–5% default 0, fixed 0%, or fixed ≤5%?** Recommended the first.
   At realistic volume the revenue difference is single dollars a month; the question is really
   what you want to say to artists.
2. **Run the Phase 0 demand test first, or build straight after membership?** Recommended test first
   — it costs a small PR and could save the lawyer's fee.
3. **Budget for the lawyer review (low four figures) and possibly an LLC ($500 + $500/yr)?** If no,
   tips don't ship — this isn't a gate to skip.

**Later:**

4. **Minimum $3 and presets $5/$10/$20** — agree?
5. **Should an artist's own tip button replace their Ko-fi link in the patronage list, or sit beside
   it?** Recommended beside, ordered first; let the artist hide the others if they want.
6. **Mirlo overlap.** Mirlo artists already take Stripe-connected payments with Mirlo's fee. Worth a
   friendly note to Mirlo before launch so this reads as complementary, not competitive.

---

## 11. Repo touchpoints

| Concern | Where |
|---|---|
| Migration | `supabase/migrations/YYYYMMDDHHMMSS_artist-tips.sql` — two server-only tables |
| Functions | `api/functions/tips-connect.ts`, `tips-settings.ts`, `tips-checkout.ts`, `tips-webhook.ts` |
| Typecheck + tests | `api/tsconfig.json` `include`; `api/functions/__tests__/tips-*.test.ts` |
| Eligibility join | `api/functions/db.ts` `getArtistBySlug`; search result shaping in `search-utils.ts` (not `search-sources.ts`) |
| Routes | `netlify.toml` `/api/tips/*` redirects before the SPA catch-all |
| CSP | No change (hosted Checkout) |
| SSRF | `middleware.ts` allowlist — `api.stripe.com`, added once for both specs |
| Artist page | `api/edge/artist-page-static.ts` — plain link to `/tip/{slug}` |
| SPA | `apps/web/src/pages/TipPage.tsx`, `TipThanksPage.tsx`; `ResultCard*`; `ArtistDashboardPage.tsx` |
| Registry | `api/shared/platform-registry.ts` — Unstream tips as a patronage entry, payout shown as the live net % |
| Mac | now-playing card in `Views/macOS/PopoverView.swift`; nothing on iOS |
| Extension | `apps/extension/` popup |
| Open Books | `tipFeeRevenue` in `data/open-books/ledger.json` and the `/api/open-books` aggregate |
| Old specs | `patronage-spec.md` marked superseded; `unstream-patronage.md` parked |
