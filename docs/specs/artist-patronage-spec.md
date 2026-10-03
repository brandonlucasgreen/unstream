---
status: Draft
---
# Artist patronage — spec

**Written:** 2026-09-27
**Status:** Draft. Decisions from Brandon, 2026-09-27, are in §11.
**Supersedes:** [artist-tips-spec.md](artist-tips-spec.md) (one-off tips only) and
[unstream-patronage.md](unstream-patronage.md) (the pooled monthly pass). The Stripe structure and the
legal reasoning in `artist-tips-spec.md` carry over unchanged and are restated here, so this is the one
to build from. `patronage-spec.md` (Express + destination charges) is deleted.
**Separate from:** [support-page-spec.md](support-page-spec.md) — Ko-fi for funding Unstream itself.

---

## 1. What this is

A fan pays an artist from inside Unstream, at the moment they're listening, and the money goes straight
to the artist. Even $1–3 is more than most streams ever pay them — Spotify pays nothing at all on a
track with under 1,000 streams a year.

Patronage platforms already exist, but they're built for generic "creators," and embedding them means
rendering someone else's page inside Unstream (Ko-fi's panel is the only one that even works). This is
built for musicians and native to the apps:

| Feature | What it is |
|---|---|
| **Quick tip** | $1 / $3 / $5 from the Mac popover's now-playing card, a result card or the artist page. |
| **The tab** | One card on file. Quick tips and recurring support add up, and are charged together on one day a month. |
| **Recurring support and the monthly split** | "$3 a month to this artist," or "$10 a month across these five." |
| **Goals** | "Pressing 300 LPs: $2,400." A Ko-fi-style tracker. |
| **Play my city** | Fans say where they'd come to a show; artists see where demand is. |
| **Demand for artists not yet taking tips** | "14 fans want to tip you." The reason for an artist to claim their profile. |
| **Year in support** | A December recap: who you paid, what you helped fund. Shareable. |

**The principle: a straight pass-through.** Every payment is one fan paying one artist, directly into
the artist's own Stripe account. Unstream never holds, pools or forwards anyone else's money. That's what
keeps this out of money-transmission territory, and §2 is the list of things that would break it.

**Why bother when demand is thin** (134 claimed artists, 69 artists saved by any fan): this is
the mission — changing fans' habits and moving money back to artists rather than middlemen — and it's
the thing that makes Unstream worth pitching. Tips and Play my city are the differentiators.

---

## 2. The line

With Standard accounts and direct charges (§4), Unstream's Stripe balance only ever holds Unstream's own
fee. Three levels of risk, and a line:

| Level | Includes | Money in Unstream's balance | Risk Unstream carries |
|---|---|---|---|
| **0. No money** | Play my city, tip demand counts, goals shown, Year in support | None | None |
| **1. One-off tips** | Hosted Checkout, direct charge on the artist's account, optional fee | Unstream's fee only | Card testing on the tip form; profile impersonation (§6); platform approval |
| **2. The tab** | Saved card, quick tips, recurring, split, scheduled charges | Unstream's fee only | Holding fans' saved cards through Stripe; recurring-charge rules (consent, notice, easy cancel); **scheduler bugs** — a double charge is refunded from the artist's balance, but the mess is Unstream's |
| **The line** | Anything below | **Other people's money** | Money transmission, a lawyer, an LLC |

**Never ships:**

- **Holding tips for artists who aren't taking them.** Instead, count demand (§3.6) so the artist notices
  and claims their profile. *Brandon, 2026-09-27.*
- **Accumulating money to reach a minimum.** The tab accumulates *intent* — rows in a ledger — and money
  moves only on the charge date, fan to artist (§3.2).
- **Conditional pledges** held until a goal or a show happens. Goals are trackers; every tip is
  unconditional (§3.4). *Brandon: "like Ko-fi, not Kickstarter."*
- **Splitting one charge across several people** — band members, credited musicians. A band takes tips
  through one Stripe account and splits it themselves.
- **A "tip Unstream too" line inside an artist's charge.** That would be Unstream skimming the artist's
  revenue, which Stripe's tips policy prohibits. If Unstream's own support ever moves into this flow, it's
  a separate charge on Unstream's own account (§11, later).

---

## 3. Features

### 3.1 Quick tip

A **Tip** button wherever the artist appears: the Mac popover's now-playing card and result rows, web
result cards, the artist page. It sits in the patronage category, first, because it pays ~91–95%.

- **Signed in, with a card on file:** $1 / $3 / $5 presets (plus custom) add an entry to the fan's tab
  (§3.2). No browser, no web view — on the Mac it's a native SwiftUI sheet calling the API. Confirmation
  says what happens: "$3 for {artist}, charged with your tab on Oct 1."
- **Anyone else:** opens `/tip/{slug}` in the browser — a one-off payment through hosted Stripe Checkout
  on the artist's account, **minimum $3** (a $1 card charge loses a third to the fixed fee, §5). The page
  offers "set up quick tips" for next time.
- Optional: attach the tip to one of the artist's open goals (§3.4), or to the release that's playing.

### 3.2 The tab

One card on file, one charge date a month, every artist the fan supports.

1. **Save a card once.** Hosted Stripe Checkout in *setup* mode on Unstream's platform account, from
   `/settings/support`. The fan picks a **charge day** (1–28) and a **monthly cap** (default $50), and
   consents to future charges (§6).
2. **Entries accumulate.** Quick tips and each month's recurring amounts are written as rows in an
   append-only ledger (`support_entries`). No money moves.
3. **Notice, three days before.** An email and the settings page list what will be charged: "Oct 1:
   Artist A $4.20 · Artist B $3.10 · Artist C $1.40 building up." The fan can remove any entry until the
   charge runs.
4. **The charge run.** On the fan's charge day, for each artist whose uncharged entries total **$3 or
   more**, one direct charge on that artist's account for that total, using the fan's saved card. Smaller
   totals carry over. The fan's bank statement shows each artist by name, because each artist is the
   seller.
5. **Carry-over has an end.** Entries uncharged after **six months** are charged at whatever they total
   (minimum $1), with the fee shown — the fan meant to pay that artist. *Proposed; §11 open question 1.*

**Why this shape:** one charge per artist per month instead of one per tip. Three $1 quick tips and a $3
recurring amount cost $1.37 in fees as four charges, and 47¢ as one.

**The ledger is the tracking.** Entries are never edited, only linked to the payment that charged them
or marked void. Everything else — the tab's balance, an artist's pending total, a goal's progress — is
derived from it. The run is idempotent per (fan, artist, period) (§9).

**When things go wrong:**

| Case | What happens |
|---|---|
| Card declined | Entries stay uncharged, the fan is emailed, the next charge day retries. Two failures in a row pause the tab. |
| The bank wants authentication (SCA, mostly EU/UK cards) | The fan is emailed a link that opens hosted Checkout on the artist's account for that amount. No Stripe.js, no CSP change. |
| The artist stopped taking tips | Their entries are voided at the run, and the fan is told: "{Artist} stopped taking tips, so your $4 wasn't charged." |
| The cap would be exceeded | Quick tips beyond it are refused with a message; the run never charges more than the cap. The cap is the safety net against Unstream's own bugs. |

### 3.3 Recurring support and the monthly split

- **Recurring:** "$3 a month to {artist}." Adds an entry to the tab each month, on the charge day.
- **The monthly split:** the fan sets a budget, picks artists from their saved artists, and splits it
  equally or with their own weights. It writes one recurring amount per artist — the split is a UI over
  recurring support, not a separate mechanism.
- Only artists taking tips can be picked. The rest show "not taking tips yet — tell them you'd tip"
  (§3.6).
- Weighting the split by plays is **not in scope** (Brandon, 2026-09-27: not enough users, too many
  assumptions). It would only recompute the recurring amounts, so it can come later without schema
  changes.
- A signed-in fan's first successful payment marks the artist **supported** in their saved artists;
  recurring support marks them **`patron`** in the Support List (the state `mac-app-premium-spec.md`
  reserved for this).

### 3.4 Goals

Artists create up to three open goals: title, target amount, and optionally a city or a release.

- **Progress** is what the artist has received for that goal: charged entries and one-off tips tagged
  with it. The bar can pass 100%. The artist closes a goal whenever they like.
- **Tips are unconditional**, and the copy says so. No holds, no refunds on close, no "funded or your
  money back." The tip sheet says: "Tips go to {artist} straight away, whether or not the goal is met."
- Copy frames goals as asks, not campaigns: "Help me press this on vinyl," "Help me play your city."
- Goals are music-shaped: pressing, mastering, a tour stop, studio days, van repairs. Offer those as
  starting points in the goal form, not as categories.

### 3.5 Play my city

A **Play my city** button on the artist page, result cards and the Mac app. Signed-in fans only, one city
per fan per artist, pre-filled from their profile location (`usernames.location`) and editable.

- **The artist's dashboard** shows the top cities with counts. That's routing data artists actually use,
  and it doesn't depend on the blocked Bandsintown integration.
- **The public artist page** shows "Most wanted in: Boston (12), Leeds (5)" once a city reaches three,
  so a count can't point at one person in a small town.
- **It works for unclaimed artists too** — the counts are there waiting when they claim.
- **With a city goal** ("Help me play Boston"), fans in that city see it first.

No money, so this ships before any of the Stripe work.

### 3.6 Demand for artists not yet taking tips

Where an artist can't take tips (unclaimed, claimed but not connected, or in a country Stripe doesn't
support), the Tip button becomes **"I'd tip them"**. It records one row per signed-in fan per artist. No
amount is recorded or charged.

- The count appears on the artist page once it reaches three: "14 fans want to tip {artist}. Are you
  {artist}? Claim your profile." It shows on the claim flow and, after claiming, on the dashboard beside
  "Connect Stripe."
- Count only. An amount would read as money waiting somewhere, and there isn't any.

### 3.7 Year in support

A December recap. It needs no payments to exist, so the 2026 edition runs on whatever is live.

- **Contents:** artists you paid and how much, goals you helped, cities you asked for, records you bought
  (Bandcamp collection items, where the import recorded a date), artists you saved and marked supported.
- **Private view** in the SPA at `/year/{year}`.
- **Public version** at `/u/{handle}/{year}`, rendered by the `u-handle` edge function, and only if the
  fan's list sharing is on. It follows the same one-route-one-renderer rule as `/u/:handle`. Amounts are
  hidden by default; the fan can turn their total on.
- **Share image** for social posts: generated by the edge function, same data as the public page.

---

## 4. Payments

### Standard accounts + direct charges

Carried over from `artist-tips-spec.md` §3, where the comparison with Express + destination charges is
written out.

| | |
|---|---|
| **Platform** | Unstream's Stripe account (a sole-proprietor account is fine, §6). |
| **Artist accounts** | Stripe Connect **Standard**, with `controller.stripe_dashboard.type: full`, `controller.fees.payer: account`, `controller.losses.payments: stripe`, `controller.requirement_collection: stripe`. Onboard with Account Links, or OAuth for an existing Stripe account. |
| **Charges** | **Direct charges** on the artist's account, with `application_fee_amount` for Unstream's fee. The artist is merchant of record. |
| **What Unstream doesn't carry** | Connect fees (Stripe bills the artist's account), chargeback and fraud losses, 1099-Ks (Stripe files them), refunds and disputes (the artist's own dashboard). |
| **Checkout** | Hosted everywhere: one-off tips, the SCA fallback, and card setup. No Stripe.js, no CSP change. |

### Saved cards

The fan's card is saved once as a Customer and PaymentMethod on the **platform** account. At each charge
it is **cloned** to the artist's connected account and charged off-session there.

**Verify in test mode before building:**

- that cloning to Standard accounts works for off-session direct charges;
- whether a connected-account Customer has to be kept per (fan, artist) — if so, add a table.

### Stripe's tips policy

A tip must be for a good or service, and you may not accept donations on someone else's behalf. With
direct charges the *artist* accepts each tip, for their music; Unstream stores a card for the fan's
convenience and accepts nothing. Describe exactly that in the Connect platform profile: "artists accept
tips for their music through their own Stripe accounts; fans can save a card with us to tip several
artists on one monthly date; we take an optional artist-chosen fee." Approval is the confirmation. Copy
everywhere says **support for an artist's music**, never "donate."

### Countries and currency

- **Countries:** Standard accounts exist only where Stripe operates (~46 countries). An artist elsewhere
  sees "Stripe isn't available in {country} yet" with a link to add Ko-fi, Patreon or Liberapay to their
  profile. Fans see "I'd tip them" (§3.6) — which here is only a signal, so the artist dashboard shouldn't
  imply Unstream can fix it.
- **Currency:** USD in v1. Checkout presents local currency where Stripe supports it.

---

## 5. Money

Stripe's standard US pricing, 2.9% + 30¢, paid by the artist's account (**verify; international cards
add ~1.5%, currency conversion ~1%**):

| Charge | Stripe fee | % lost |
|---|---|---|
| $1 | 33¢ | 32.9% |
| $3 | 39¢ | 12.9% |
| $5 | 45¢ | 8.9% |
| $10 | 59¢ | 5.9% |
| $20 | 88¢ | 4.4% |

- **One-off minimum $3; presets $5 / $10 / $20.** A one-off is always one charge.
- **Quick-tip presets $1 / $3 / $5.** Possible only because the tab combines them (§3.2).
- **Tab charges are at least $3 per artist**, except the six-month carry-over.
- **Unstream's fee: artist-chosen, 0–5%, default 0%.** Shown to the fan either way.
- **Cover the fees:** on by default. It grosses up each charge so the artist nets what the fan chose:
  `(amount + 0.30) / (1 − 0.029 − fee%)`. The server computes it; clients only display it.
- **The breakdown is always shown before paying:** "You pay $5.46 · Stripe keeps $0.46 · Unstream keeps
  $0 · {Artist} gets $5.00."
- **Refunds return Unstream's fee** (`refund_application_fee: true`).

---

## 6. Legal, tax and trust — gates

Not legal advice. The reasoning in `artist-tips-spec.md` §5 holds and is summarised here.

- **Money transmission:** with direct charges on Standard accounts, Unstream never receives, holds or
  sends the funds, so it arguably isn't transmitting anything (M.G.L. c. 169B). Ko-fi, Mirlo and
  Liberapay work this way. **The structure is load-bearing** — anything across the line in §2 changes
  this, and at that point a lawyer stops being optional.
- **Entity:** an LLC is optional, something to buy when volume makes the risk worth insuring.
- **Tax:** VAT/GST on tips is the artist's, as merchant of record. Unstream's fee is Brandon's income;
  whether Massachusetts sales tax reaches it is an accountant question that only arises for artists who
  opt in.

**Gates before real money:**

1. **Stripe platform approval** with the model in §4 described accurately. It's independent of code, so
   apply first.
2. **Terms.** A patronage section in the terms of use (Unstream isn't a party to the tip; no funds held;
   tips are unconditional; the fee is the artist's choice), and an **artist addendum** accepted when an
   artist turns tips on (they're the seller; refunds and disputes are theirs; Unstream can switch tips off
   for abuse or misrepresentation).
3. **Admin approval of each artist's first tips setup** in `/admin/verify`, showing the claimed artist
   beside the connected Stripe account's business name and country. Approval sets `tips_approved_at`;
   checkout and the charge run both refuse without it. Changing the connected account needs re-approval.
   This is the defence against someone claiming a profile and collecting an artist's tips.
4. **Before the tab (level 2):**
   - consent text at card setup ("Unstream will charge this card for the support you queue for artists,
     on the {n}th of each month, never more than ${cap}");
   - the pre-charge notice (§3.2);
   - a privacy policy line on saved cards;
   - cancelling is removing entries and recurring amounts, one tap each, and deleting the card.

---

## 7. Surfaces

| Surface | Quick tip | One-off | The tab | Play my city / I'd tip them | Year in support |
|---|---|---|---|---|---|
| **Web** | Result cards, artist page | `/tip/{slug}` | `/settings/support` | Artist page, result cards | `/year/{year}`, `/u/{handle}/{year}` |
| **Mac** | Native sheet on the now-playing card and result rows | Opens `/tip/{slug}` in the browser | Opens `/settings/support` | Native buttons | Opens the web page |
| **Extension** | Opens `/tip/{slug}` | Opens `/tip/{slug}` | — | Opens the artist page | — |
| **iOS** | — | — | — | — | — |

- **Artist pages are edge-rendered** (`artist-page-static`). The edge function renders plain links and
  counts. The Tip button links to `/tip/{slug}`, and the SPA owns that sheet. The SPA never takes over the
  artist page to show a modal. This is the same pattern as `/u/:handle`'s Copy URL button.
- **The Mac sheet is native SwiftUI** calling the API with the fan's existing session. No web view, no
  third-party HTML.
- **Nothing on iOS.** App Review 3.2.1(vii) allows gifts to individuals outside in-app purchase only if
  100% reaches the recipient; card fees and the optional Unstream fee both break that.
- **The extension** gets native quick tips later, if its auth supports it.

## 8. Artist experience

In the artist settings area's **Manage Tips** tab (`/artist-edit/:slug/tips`, `ArtistTipsPage.tsx`), per claimed profile. *Moved off the dashboard 2026-10-02 (Brandon): the dashboard already serves artists and listeners and was getting crowded.*

1. **Demand** — always shown, before and after connecting: "I'd tip them" count, Play my city top cities.
2. **Not connected** — explanation, the fee table, "Connect Stripe" → Account Link. An unsupported country
   gets the message in §4 instead.
3. **Onboarding incomplete** — "Stripe needs a few more details" → a fresh Account Link.
4. **Awaiting approval** — after first enable, until an admin approves (§6).
5. **Connected** — on/off, Unstream fee 0–5% (default 0), goals (create, close), a preview of what fans
   see, totals this month and all time (count, gross, net), and a link to their Stripe dashboard for
   everything else. No transaction table; Stripe's is better and already theirs.

---

## 9. Architecture

### Data model

`supabase/migrations/YYYYMMDDHHMMSS_artist-patronage.sql`. **Every table is server-only: RLS enabled, no
policies**, with a comment saying that's deliberate. Every read goes through a service-role function that
checks ownership. Any RPC function revokes EXECUTE from `PUBLIC, anon, authenticated`.

```
artist_tip_accounts       -- one per claimed artist who has connected Stripe
  artist_id            uuid pk → artists(id) on delete cascade
  stripe_account_id    text unique not null
  charges_enabled      boolean not null default false   -- mirrored from account.updated
  tips_approved_at     timestamptz null                 -- §6; reset when stripe_account_id changes
  tips_enabled         boolean not null default false   -- the artist's switch
  fee_basis_points     integer not null default 0 check (between 0 and 500)
  country              text null
  created_at, updated_at

fan_payment_accounts      -- the tab's settings; one per fan with a saved card
  user_id              uuid pk → auth.users(id) on delete cascade
  stripe_customer_id   text unique not null             -- on the platform account
  payment_method_id    text null                        -- card details are read from Stripe, not stored
  charge_day           smallint not null check (between 1 and 28)
  monthly_cap_cents    integer not null default 5000
  cover_fees           boolean not null default true
  consented_at         timestamptz not null             -- §6 consent text, versioned in code
  consecutive_failures smallint not null default 0      -- two pauses the tab
  created_at, updated_at

recurring_support         -- "$3 a month to this artist"; the split writes these too
  user_id, artist_id   pk; → auth.users, → artists
  monthly_cents        integer not null check (>= 100)
  created_at, updated_at

support_entries           -- the ledger; append-only
  id                   uuid pk
  user_id              uuid not null
  artist_id            uuid not null
  amount_cents         integer not null check (> 0)
  source               text check (in ('quick_tip','recurring','checkout'))
  goal_id              uuid null → artist_goals(id)
  release_id           uuid null → releases(id)
  payment_id           uuid null → tip_payments(id)     -- set when charged
  voided_at            timestamptz null                 -- removed by the fan, or the artist stopped taking tips
  void_reason          text null
  created_at

tip_payments              -- one per Stripe charge
  id                   uuid pk
  artist_id            uuid not null
  stripe_account_id    text not null
  stripe_payment_intent_id text unique not null         -- webhook replays are no-ops
  amount_cents         integer not null                 -- what the artist was tipped
  gross_cents          integer not null                 -- what the fan paid, after any gross-up
  application_fee_cents integer not null
  currency             text not null
  fan_user_id          uuid null                        -- private; null for signed-out one-offs
  channel              text check (in ('checkout','scheduled'))
  period               date null                        -- the charge date, for scheduled charges
  status               text check (in ('pending','requires_action','succeeded','failed','refunded','disputed'))
  livemode             boolean not null                 -- from Stripe; every aggregate filters on true
  created_at
  unique (fan_user_id, artist_id, period)               -- one scheduled charge per artist per run

artist_goals
  id, artist_id, title (≤ 80), target_cents, city_key null, city_label null,
  release_id null, status ('open','closed'), created_at, closed_at

tip_interest              -- "I'd tip them"
  user_id, artist_id   pk; created_at

city_interest             -- Play my city
  user_id, artist_id   pk; city_key, city_label, created_at
```

- **Goal progress, an artist's pending total and the fan's tab** are queries over `support_entries`
  joined to `tip_payments` (succeeded, livemode). No counters to keep in sync.
- **One-off checkouts also write `support_entries`** (source `checkout`) when their payment succeeds, so
  goals and Year in support read one table.
- **`city_key`** is the lowercased, trimmed city with its country. Free-text cities are messy, so the
  input suggests existing keys as the fan types (§11 open question 5).
- **No fan PII:** no emails, names or card data. `fan_user_id` and `user_id` are the only links.
- **Why `livemode`:** `npm run dev` writes to production Supabase. Test-mode payments made locally land in
  the same tables and have to be excluded from everything real.
- **Paging:** the charge run and any artist-wide aggregate use `readAllPages`. PostgREST truncates silently
  at 1,000 rows.
- **Disk I/O:** low-volume writes (a row per tip, per interest tap, per charge). The run reads only fans
  whose `charge_day` is today. No new indexes beyond the primary keys and `support_entries (user_id)
  where payment_id is null and voided_at is null`.

### Functions

All added to `api/tsconfig.json`'s `include`, with tests in `api/functions/__tests__/`. Money endpoints
don't get to fail at runtime in production.

| Function | Route | Auth | Notes |
|---|---|---|---|
| `tips-connect.ts` | `POST /api/tips/connect` | Bearer + owns the claimed, verified profile | Creates the connected account if missing, returns an Account Link. `account` limiter. |
| `tips-settings.ts` | `GET/PUT /api/tips/settings` | Bearer + ownership | On/off, fee, goals, totals, demand counts. |
| `tips-checkout.ts` | `POST /api/tips/checkout` | Public | `{ artistSlug, amountCents, coverFees, goalId? }` → re-reads eligibility, computes gross-up and fee server-side, creates a Checkout Session on the artist's account → `{ url }`. Also serves the SCA fallback for a scheduled payment. `strict` limiter per IP (card-testing defence). |
| `tips-webhook.ts` | `POST /api/tips/webhook` | Stripe **Connect** signature | `checkout.session.completed`, `payment_intent.succeeded` / `payment_failed`, `charge.refunded`, `charge.dispute.created`, `account.updated`. Base64-decode the body on Netlify before verifying. No rate limiter. |
| `me-support.ts` | `GET/POST/PUT/DELETE /api/me/support` | Bearer | The tab: entries, recurring and split, charge day, cap, cover fees, card summary (read from Stripe), quick tips (`POST`, checks cap and eligibility), removing an entry (void). `account` limiter. |
| `me-support-card.ts` | `POST/DELETE /api/me/support/card` | Bearer | `POST` creates a setup-mode Checkout Session on the platform account. On return, the SPA calls `PUT` with the session id, and the server retrieves the session and stores the PaymentMethod. That avoids a second webhook endpoint. `DELETE` detaches the card and pauses the tab. |
| `support-charge-run.ts` | `POST /api/support/charge-run` | Shared secret header | Daily. Sends notices for fans whose charge day is in three days; charges fans whose charge day is today (§3.2). One PaymentIntent per (fan, artist, period), idempotency key `run:{user}:{artist}:{period}`. Runs from a GitHub Actions cron, like `recatalog-sweep.yml` — there are no scheduled Netlify functions in this repo. |
| `artist-interest.ts` | `POST/DELETE /api/artist-interest` | Bearer | `{ artistId, kind: 'tip' \| 'city', city? }`. Counts are joined into the artist page and result payloads server-side. `account` limiter. |
| `me-year.ts` | `GET /api/me/year/{year}` | Bearer | Year in support data. The public version is read by the `u-handle` edge function through `public-saved-artists.ts`'s pattern. |

### Security notes

- **The client sends an amount; the server decides the rest** — eligibility, fee, gross-up, cap. Never
  trust a client-computed figure.
- **Ownership** is checked against `artist_profiles.user_id` and `verified_at` on every artist-side call,
  not just in the UI.
- **The run is idempotent twice over:** the Stripe idempotency key, and `unique (fan_user_id, artist_id,
  period)`. Entries are linked to a payment only when it succeeds.
- **Stripe keys per Netlify context:** live keys in Production only, test keys in the dev context.
  `netlify dev` injects site env, so a site-wide live key would let a laptop charge real cards.
- **`api.stripe.com`** goes in `ALLOWED_OUTBOUND_HOSTNAMES`, with a comment.
- **Never log** amounts tied to a user, account ids next to emails, or event bodies. Sentry gets the
  error, not the payload.
- **Card testing:** the `strict` limiter on `tips-checkout`, plus Stripe Radar on each artist's account.
  Quick tips need a signed-in fan with a saved card and are bounded by the cap.

---

## 10. Phasing

Brandon's estimate is a weekend of building, minus testing. The phases are about what can **go live**
when, not about build time.

0. **Apply for Stripe platform approval now.** It's the longest lead time and needs no code.
1. **No money — ships first.** Play my city, "I'd tip them," the public counts, and the dashboard's demand
   panel. It's the first differentiator to pitch, and it starts collecting claim hooks.
2. **Artists and one-off tips.**
   - Migration, `tips-connect`, `tips-settings`, `tips-webhook`, `tips-checkout`.
   - Admin approval queue, goals, `/tip/{slug}` and `/tip/thanks`.
   - The Tip button on the web and the Mac app (opening the browser).
   - Terms and artist addendum.
3. **The tab.** Saved card, quick tips (the native Mac sheet), recurring and split, the charge run and
   notices, the cap. Consent text and privacy policy line first.
4. **Year in support.** December 2026, on whatever exists by then.

**Later:**

- weighting the split by plays;
- native quick tips in the extension;
- multi-currency presets;
- retiring Ko-fi for Unstream's own support in favour of a separate charge on the platform account, if
  this takes off.

---

## 11. Decisions and open questions

**Decided (Brandon, 2026-09-28):**

- **Phase 1 is dropped: no "I'd tip them" and no Play my city.** "I'd tip them" is a vaporware demand
  test when many artists already list a Ko-fi or Patreon, and Play my city is hollow without far more
  traffic and a much richer artist dashboard. Build starts at Phase 2. §3.5, §3.6 and the Phase 1 rows
  elsewhere in this spec are superseded; goals carry no city.

**Decided (Brandon, 2026-09-27):**

- Patronage inside the Unstream apps is the core. It's a straight pass-through to the artist, Ko-fi-style,
  but at the listening moment.
- The Stripe structure stays: Standard accounts, direct charges.
- Unstream's fee is optional, artist-chosen 0–5%, default 0%.
- **Never hold tips for unclaimed artists**; count demand instead so they claim.
- **Running totals are fine** with a ledger that tracks them properly (§3.2, §9).
- **Goals are Ko-fi-style trackers, not Kickstarter-style pledges.** Tips are unconditional, and the copy
  says so ("Help me play your city").
- One card on file, and one charge date across every artist the fan supports.
- Holding fans' cards (through Stripe) is fine.
- **No estimate of what streaming paid**, and no plays-weighted split for now: not enough users, too many
  assumptions.
- Ko-fi can be retired for Unstream's own support later, if this takes off.

**Open:**

1. **Carry-over:** after six months, charge whatever is there (minimum $1)? Proposed yes. The alternatives
   are letting entries expire, or asking the fan to round up to $3.
2. **Public counts:** show "I'd tip them" and Play my city counts at three or more, including on
   unclaimed artists' pages? Proposed yes.
3. **Default monthly cap:** $50?
4. **Year in support, public:** amounts hidden by default? Proposed yes.
5. **Cities:** free text with suggestions, or a fixed list? Proposed free text with suggestions for v1.
6. **Presets:** quick tips $1 / $3 / $5, one-off $5 / $10 / $20, one-off minimum $3 — agree?
7. **Mirlo:** a friendly note before launch, since Mirlo artists already take Stripe-connected payments.
   Carried over from the tips spec.

---

## 12. Repo touchpoints

| Concern | Where |
|---|---|
| Migration | `supabase/migrations/YYYYMMDDHHMMSS_artist-patronage.sql` — the tables in §9, all server-only |
| Functions | `api/functions/tips-*.ts`, `me-support.ts`, `me-support-card.ts`, `support-charge-run.ts`, `artist-interest.ts`, `me-year.ts` |
| Typecheck + tests | `api/tsconfig.json` `include`; `api/functions/__tests__/` — amount bounds, the §5 fee table as fixtures, gross-up, cap, ownership, ineligible artist, signature failure, base64 body, replayed event, run idempotency, carry-over, void on ineligible artist |
| Scheduler | `.github/workflows/support-charge-run.yml`, daily, modelled on `recatalog-sweep.yml` |
| Eligibility and counts | `api/functions/db.ts` `getArtistBySlug`; result shaping in `search-utils.ts`, not `search-sources.ts` |
| Routes | `netlify.toml` — `/api/tips/*`, `/api/me/support*`, `/api/support/charge-run`, `/api/artist-interest` before the SPA catch-all |
| CSP | No change — hosted Checkout for payments, setup and the SCA fallback |
| SSRF | `middleware.ts` — `api.stripe.com` in `ALLOWED_OUTBOUND_HOSTNAMES` |
| Artist page | `api/edge/artist-page-static.ts` — Tip link, Play my city link, counts, open goals |
| Year in support, public | `api/edge/u-handle.ts` — `/u/{handle}/{year}` and its share image |
| SPA | `TipPage.tsx`, `TipThanksPage.tsx`, `SupportSettingsPage.tsx` (the tab), `YearInSupportPage.tsx`; `ResultCard*`; `ArtistTipsPage.tsx` (Manage Tips tab) |
| Registry | `api/shared/platform-registry.ts` — Unstream tips as a patronage entry; payout shown as the live net % |
| Mac | `Views/macOS/NowPlayingView.swift`, `Views/Shared/ArtistResultView.swift` — Tip sheet, Play my city; `patron` state in `SupportListView.swift` |
| Extension | `apps/extension/popup/` — links out to `/tip/{slug}` and the artist page |
| Emails | Pre-charge notice, failed charge, SCA link, voided entries — through the existing Resend path and `email_log` |
| Tips approval | `apps/web/src/pages/AdminVerifyPage.tsx`, `api/functions/admin-verify.ts` |
| Terms and privacy | `TermsOfUsePage.tsx` — patronage section; artist addendum at enable time; `PrivacyPolicyPage.tsx` — saved cards, what Stripe collects |
