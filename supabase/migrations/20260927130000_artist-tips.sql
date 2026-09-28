-- Artist patronage, phase 2: artists take one-off tips through their own Stripe accounts
-- (docs/specs/artist-patronage-spec.md §4, §6, §9).
--
-- The money flow this schema records, and the only one it supports: a fan pays through hosted
-- Stripe Checkout as a *direct charge on the artist's own Standard connected account*, with
-- Unstream's optional artist-chosen fee as `application_fee_amount`. Unstream's balance only ever
-- receives that fee. Nothing here holds, pools or forwards anyone else's money (spec §2).
--
-- Every table is server-only: RLS enabled, no policies, deliberately. The service-role client
-- (getClient() in db.ts) is the only reader or writer; each endpoint checks ownership itself.
--
-- livemode, on accounts and payments: `npm run dev` points at production Supabase with test-mode
-- Stripe keys. A test-mode connected account or payment made from a laptop lands in these same
-- tables, so every row records which mode it came from and every read filters on the mode of the
-- key the server holds. Production (live key) never sees a test row, and a test account can't
-- overwrite an artist's live one because the mode is part of the key.
--
-- Phase 3 (the tab: saved cards, recurring support, the scheduled charge run) adds its own tables
-- and the scheduled-charge columns on tip_payments in a later migration; none of it is created here.

-- ---------------------------------------------------------------------------------------------
-- artist_tip_accounts: one per claimed artist per Stripe mode.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artist_tip_accounts (
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  livemode boolean NOT NULL,
  stripe_account_id text NOT NULL UNIQUE,
  -- The artist_profiles.user_id who connected this account. Eligibility requires it to still be
  -- the profile's owner, so if a profile is ever released and re-claimed by someone else, the new
  -- claimant can't collect tips into the previous owner's Stripe account (or vice versa).
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  charges_enabled boolean NOT NULL DEFAULT false,      -- mirrored from Stripe (account.updated)
  details_submitted boolean NOT NULL DEFAULT false,    -- mirrored from Stripe
  country text,                                        -- ISO 3166-1 alpha-2, from Stripe
  -- Spec §6 gate 3: set by an admin in /admin/verify after comparing the claimed artist with the
  -- connected account's business name and country. Checkout refuses without it. Cleared whenever
  -- stripe_account_id changes.
  tips_approved_at timestamptz,
  tips_enabled boolean NOT NULL DEFAULT false,         -- the artist's own switch
  fee_basis_points integer NOT NULL DEFAULT 0 CHECK (fee_basis_points BETWEEN 0 AND 500),
  -- Spec §6 gate 2: the artist addendum, accepted when they connect. The version is the constant
  -- ARTIST_ADDENDUM_VERSION in api/shared/tips.ts, so a changed addendum can be re-asked.
  addendum_accepted_at timestamptz NOT NULL,
  addendum_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artist_id, livemode)
);

DROP TRIGGER IF EXISTS artist_tip_accounts_updated_at ON artist_tip_accounts;
CREATE TRIGGER artist_tip_accounts_updated_at
  BEFORE UPDATE ON artist_tip_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE artist_tip_accounts ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE artist_tip_accounts IS
  'Artists'' Stripe Connect Standard accounts, one per artist per Stripe mode. Server-only; no RLS policies by design.';

-- ---------------------------------------------------------------------------------------------
-- artist_goals: Ko-fi-style trackers, never pledges. Tips are unconditional (spec §3.4).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artist_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  target_cents integer NOT NULL CHECK (target_cents BETWEEN 100 AND 10000000),
  city_key text,
  city_label text,
  release_id uuid REFERENCES releases(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- The artist page and checkout read an artist's open goals; three at most, so this stays tiny.
CREATE INDEX IF NOT EXISTS idx_artist_goals_artist ON artist_goals (artist_id) WHERE status = 'open';

ALTER TABLE artist_goals ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE artist_goals IS
  'Artist goals ("Pressing 300 LPs: $2,400"). Trackers only — no holds, no conditional pledges. Server-only; no RLS policies by design.';

-- ---------------------------------------------------------------------------------------------
-- tip_payments: one row per Stripe charge, written by the Connect webhook.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tip_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL,
  -- Unique so a replayed webhook event is a no-op: the second insert hits this and is skipped.
  stripe_payment_intent_id text NOT NULL UNIQUE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),         -- what the fan chose to tip
  gross_cents integer NOT NULL CHECK (gross_cents >= amount_cents), -- what the fan paid, after any gross-up
  application_fee_cents integer NOT NULL DEFAULT 0 CHECK (application_fee_cents >= 0),
  currency text NOT NULL,
  fan_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- private; null when signed out
  channel text NOT NULL CHECK (channel IN ('checkout')),
  status text NOT NULL CHECK (status IN ('pending', 'requires_action', 'succeeded', 'failed', 'refunded', 'disputed')),
  livemode boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS tip_payments_updated_at ON tip_payments;
CREATE TRIGGER tip_payments_updated_at
  BEFORE UPDATE ON tip_payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- The dashboard's totals read one artist's payments.
CREATE INDEX IF NOT EXISTS idx_tip_payments_artist ON tip_payments (artist_id, livemode, created_at);

ALTER TABLE tip_payments ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE tip_payments IS
  'One row per Stripe charge on an artist''s connected account. Carries no card data or fan PII beyond the user id. Server-only; no RLS policies by design.';

-- ---------------------------------------------------------------------------------------------
-- support_entries: the ledger (spec §3.2, §9). Append-only: rows are linked to the payment that
-- charged them or voided, never edited otherwise. Goal progress is derived from it.
--
-- In phase 2 only source = 'checkout' is written: one entry per succeeded one-off tip, so goals
-- (and later Year in support) read one table. Deviation from the spec's sketch, deliberately:
-- user_id is nullable for 'checkout' entries, because a signed-out fan can tip and there is no
-- user to record — the alternative was goals that forget every signed-out tip.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  source text NOT NULL CHECK (source IN ('checkout')),
  goal_id uuid REFERENCES artist_goals(id) ON DELETE SET NULL,
  release_id uuid REFERENCES releases(id) ON DELETE SET NULL,
  payment_id uuid REFERENCES tip_payments(id) ON DELETE SET NULL,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Goal progress reads entries by goal.
CREATE INDEX IF NOT EXISTS idx_support_entries_goal ON support_entries (goal_id) WHERE goal_id IS NOT NULL;

ALTER TABLE support_entries ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE support_entries IS
  'The support ledger. Append-only; linked to a payment or voided, never otherwise edited. Server-only; no RLS policies by design.';

-- ---------------------------------------------------------------------------------------------
-- Aggregates. Each filters on the Stripe mode the server runs in (p_livemode) and counts only
-- succeeded payments, so a refund or dispute drops out of every total.
-- ---------------------------------------------------------------------------------------------

-- What each goal has received: entries whose payment succeeded.
CREATE OR REPLACE FUNCTION public.get_goal_progress(p_goal_ids uuid[], p_livemode boolean)
RETURNS TABLE(goal_id uuid, raised_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT e.goal_id, sum(e.amount_cents)::bigint
  FROM support_entries e
  JOIN tip_payments p ON p.id = e.payment_id
  WHERE e.goal_id = ANY(p_goal_ids)
    AND e.voided_at IS NULL
    AND p.status = 'succeeded'
    AND p.livemode = p_livemode
  GROUP BY e.goal_id;
$function$;

-- The artist dashboard's totals: count, what fans paid, what the artist was tipped, Unstream's fee.
CREATE OR REPLACE FUNCTION public.get_artist_tip_totals(p_artist_id uuid, p_livemode boolean, p_since timestamptz)
RETURNS TABLE(payment_count bigint, gross_cents bigint, amount_cents bigint, application_fee_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT count(*)::bigint,
         COALESCE(sum(p.gross_cents), 0)::bigint,
         COALESCE(sum(p.amount_cents), 0)::bigint,
         COALESCE(sum(p.application_fee_cents), 0)::bigint
  FROM tip_payments p
  WHERE p.artist_id = p_artist_id
    AND p.livemode = p_livemode
    AND p.status = 'succeeded'
    AND (p_since IS NULL OR p.created_at >= p_since);
$function$;

-- CLAUDE.md, security practices: revoke from all three, rely on the service role.
REVOKE EXECUTE ON FUNCTION public.get_goal_progress(uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_goal_progress(uuid[], boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_artist_tip_totals(uuid, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_artist_tip_totals(uuid, boolean, timestamptz) TO service_role;
