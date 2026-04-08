# Artist Patronage Phase 1: One-Time Tips via Stripe Connect

## Context

Unstream links listeners to indie music stores but doesn't handle payments. This feature lets verified artists accept one-time tips directly through Unstream via Stripe Connect Express, offering a simpler, lower-fee alternative to BMC/Ko-fi/Patreon. No gated content — just tips.

Key decisions: $1/$3/$5 defaults, optional 5% platform fee (artist chooses), processing fees passed to artist, no tip UI for unverified artists.

---

## 1. Database: Migration 006

**New file:** `supabase/migration-006-patronage.sql`

### `patronage_settings` table
- `id` uuid PK
- `artist_id` uuid unique FK → artists(id) ON DELETE CASCADE
- `user_id` uuid (Supabase Auth ID, for RLS)
- `stripe_account_id` text (acct_xxx)
- `stripe_onboarding_complete` boolean default false
- `is_active` boolean default false
- `tip_amounts` integer[] default '{100,300,500}' (cents, up to 3)
- `custom_amounts_allowed` boolean default true
- `platform_fee_enabled` boolean default false
- `created_at`, `updated_at` timestamptz

### `patronage_transactions` table
- `id` uuid PK
- `artist_id` uuid FK → artists(id)
- `stripe_session_id` text unique
- `stripe_payment_intent_id` text
- `amount` integer (cents)
- `currency` text default 'usd'
- `platform_fee` integer default 0 (cents)
- `status` text CHECK in ('pending','completed','failed','refunded')
- `tipper_name` text nullable
- `created_at` timestamptz
- `completed_at` timestamptz

### RLS policies
- `patronage_settings`: public reads where `is_active = true AND stripe_onboarding_complete = true`; owner reads own (auth.uid() = user_id); service role writes
- `patronage_transactions`: service role only (reads go through authenticated API)
- Reuse existing `update_updated_at()` trigger for settings table

---

## 2. Install Stripe

Add `stripe` to root `package.json` (server-side only, never imported in `apps/web`).

New env vars for Netlify dashboard:
- `STRIPE_SECRET_KEY` (sk_test_... for dev)
- `STRIPE_WEBHOOK_SECRET` (whsec_...)
- `VITE_STRIPE_PUBLISHABLE_KEY` (pk_test_... for frontend, only needed in Phase 2 for embedded elements)

---

## 3. Backend: 5 Netlify Functions

All follow the existing pattern from `api/functions/claim-artist.ts` (CORS headers, OPTIONS preflight, rate limiting via `ratelimit.ts`, auth via Bearer JWT, Supabase service client via `db.ts`).

### 3a. `api/functions/patronage-connect.ts`
- **POST** (auth required): Create Stripe Express Connect account → upsert `patronage_settings` → return Stripe onboarding URL
- **GET** (auth required): Check onboarding status via `stripe.accounts.retrieve()`, update DB if complete, return fresh onboarding URL if incomplete
- Rate limit: strict

### 3b. `api/functions/patronage-settings.ts`
- **GET** (public): `?artist_id=<uuid>` or `?slug=<slug>` → return active tip config (amounts, custom allowed, fee enabled) or `{ active: false }`
- **PUT** (auth required): Update tip amounts (1-3 integers, each 100-50000 cents), active toggle, platform fee toggle
- Rate limit: standard

### 3c. `api/functions/patronage-checkout.ts`
- **POST** (public, no auth): `{ artistId, amount }` → validate amount 100-50000 cents → look up settings → calculate application_fee if opted in → create Stripe Checkout Session with `transfer_data.destination` → insert pending transaction → return `{ sessionUrl }`
- Rate limit: strict (card testing prevention)
- Success/cancel URLs: `/tip/success?session_id={CHECKOUT_SESSION_ID}` and `/tip/cancel`

### 3d. `api/functions/patronage-webhook.ts`
- **POST** (Stripe signature verification, no Bearer auth, no CORS)
- Handle `checkout.session.completed`: update transaction to completed
- Handle `account.updated`: update onboarding status
- **Critical Netlify detail:** check `event.isBase64Encoded` and decode before verifying signature

### 3e. `api/functions/patronage-history.ts`
- **GET** (auth required): Return completed transactions for artist(s) owned by user, paginated (`?page=1&limit=20`), ordered by completed_at desc
- Rate limit: standard

---

## 4. Netlify Config Updates

**File:** `netlify.toml`

- Add 5 redirects (before the SPA catch-all at line 99):
  - `/api/patronage/connect` → `patronage-connect`
  - `/api/patronage/settings` → `patronage-settings`
  - `/api/patronage/checkout` → `patronage-checkout`
  - `/api/patronage/webhook` → `patronage-webhook`
  - `/api/patronage/history` → `patronage-history`
- Update CSP: add `js.stripe.com` to `script-src`, `https://api.stripe.com` to `connect-src`

---

## 5. Extend `db.ts` to Surface Patronage Data

**File:** `api/functions/db.ts` — `getArtistBySlug()` (line 139)

After fetching `artist_profiles` for claimed artists (line 180-196), also query `patronage_settings` for the artist. Add to the returned `ArtistProfile` interface:

```ts
patronage?: {
  active: boolean;
  tipAmounts: number[];
  customAmountsAllowed: boolean;
}
```

This means `ArtistPage` and search results get patronage info with zero extra API calls.

---

## 6. Frontend Types

**File:** `apps/web/src/types/index.ts`

Add:
- `PatronageSettings` interface: `{ active, tipAmounts, customAmountsAllowed, platformFeeEnabled }`
- `PatronageTransaction` interface: `{ id, amount, currency, platformFee, status, tipperName?, completedAt }`
- Add optional `patronage?: { active: boolean; tipAmounts: number[]; customAmountsAllowed: boolean }` to `SearchResult`

---

## 7. Frontend Components

### 7a. `TipButton` — `apps/web/src/components/TipButton.tsx`
- Small pill button (heart icon + "Tip") following `SourceBadge.tsx` styling
- Only renders when artist has active patronage
- On click → opens TipModal
- **Placement in `ResultCard.tsx`**: next to verified badge / view profile link (~line 117-130)
- **Placement in `ArtistPage.tsx`**: in the artist header area for claimed artists

### 7b. `TipModal` — `apps/web/src/components/TipModal.tsx`
- Modal overlay with artist name + image
- Preset amount buttons (from `tipAmounts`, formatted as $X.XX)
- Custom amount input (if `customAmountsAllowed`), min $1
- "Send Tip" button → POST `/api/patronage/checkout` → redirect to `session.url`
- Loading + error states

### 7c. `PatronageSetup` — `apps/web/src/components/PatronageSetup.tsx`
- Rendered in `ArtistDashboardPage.tsx` below each profile card (after `ArtistAnalytics` at line 132)
- States: not connected → onboarding incomplete → connected+inactive → connected+active
- Settings form: 3 tip amount inputs (dollars), custom amounts toggle, platform fee toggle, save button

### 7d. `PatronageHistory` — `apps/web/src/components/PatronageHistory.tsx`
- Table in dashboard (below PatronageSetup when active)
- Columns: Date, Amount, Platform Fee, Net, Status
- Pagination, empty state, total summary

### 7e. `TipResultPage` — `apps/web/src/pages/TipResultPage.tsx`
- `/tip/success` — thank you message with link back to artist page
- `/tip/cancel` — cancelled message with link back
- Single component with `mode` prop

---

## 8. Router Updates

**File:** `apps/web/src/main.tsx`

Add lazy-loaded routes:
- `/tip/success` → TipResultPage (mode="success")
- `/tip/cancel` → TipResultPage (mode="cancel")

---

## Implementation Order

1. Migration 006 (database)
2. `npm install stripe`
3. `netlify.toml` updates (redirects + CSP)
4. `patronage-webhook.ts` (ready for Stripe events)
5. `patronage-connect.ts` (Stripe Connect onboarding)
6. `patronage-settings.ts` (tip config CRUD)
7. `patronage-checkout.ts` (checkout session creation)
8. `patronage-history.ts` (transaction history)
9. Extend `db.ts` — add patronage to `getArtistBySlug` + `ArtistProfile` interface
10. Types update (`types/index.ts`)
11. `PatronageSetup` component + wire into `ArtistDashboardPage`
12. `TipModal` component
13. `TipButton` component + wire into `ResultCard` and `ArtistPage`
14. `PatronageHistory` component + wire into dashboard
15. `TipResultPage` + router updates

---

## Verification

1. **Stripe Connect flow**: Create test Express account via dashboard → verify onboarding URL redirects → confirm `patronage_settings` row created with `stripe_onboarding_complete = true` after completing test onboarding
2. **Tip flow**: Configure tip amounts → click TipButton on artist page → verify TipModal shows correct amounts → create checkout session → complete with Stripe test card (4242...) → verify webhook fires and transaction marked completed
3. **Dashboard**: Verify PatronageSetup shows correct state for each onboarding stage → verify PatronageHistory shows completed transactions
4. **Edge cases**: Try tipping with amount < $1 (should fail) → try tipping inactive artist (should fail) → rate limit checkout endpoint (should block after threshold)
5. **Build**: `npm run build` should pass with no TS errors
6. **Existing tests**: `npm test` should still pass (no regressions)
