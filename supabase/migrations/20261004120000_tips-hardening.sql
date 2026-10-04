-- Artist tips, hardening after the first sandbox runs (docs/specs/artist-patronage-spec.md §5, §9).
--
--   1. tip_payments.refunded_cents: partial refunds. Until now a partial refund left a payment
--      'succeeded' at its full amount, so goals and totals over-counted. Every money aggregate now
--      counts what's left in proportion: amount − round(amount × refunded / gross), the same
--      arithmetic as keptAfterRefund in api/shared/tips.ts (Postgres round() on a positive numeric
--      and JS Math.round agree).
--   2. artist_tip_accounts.deauthorized_at: an artist who disconnected Unstream in Stripe can
--      connect again. tips-connect treats such a row as no account and reuses it in place for the
--      new Stripe account, resetting the approval (tips_approved_at's "cleared whenever
--      stripe_account_id changes").
--   3. artist_goals.livemode: goals belong to a Stripe mode like everything else here, so a goal made
--      while testing locally (`npm run dev` writes to production Supabase) never shows on a live
--      page. Every goal so far was made on the live site, hence DEFAULT true for existing rows.
--
-- The tables stay server-only: RLS enabled, no policies, deliberately (see 20260930170000).

-- ---------------------------------------------------------------------------------------------
-- 1. Partial refunds
-- ---------------------------------------------------------------------------------------------
-- Mirrors the charge's amount_refunded (in gross terms: what the fan paid). charge.refunded only
-- ever raises it; a refund that fails or is canceled sets it back from Stripe's charge.
ALTER TABLE tip_payments ADD COLUMN IF NOT EXISTS refunded_cents integer NOT NULL DEFAULT 0;

ALTER TABLE tip_payments DROP CONSTRAINT IF EXISTS tip_payments_refunded_cents_check;
ALTER TABLE tip_payments ADD CONSTRAINT tip_payments_refunded_cents_check
  CHECK (refunded_cents >= 0 AND refunded_cents <= gross_cents);

-- ---------------------------------------------------------------------------------------------
-- 2. Reconnecting after a disconnect
-- ---------------------------------------------------------------------------------------------
-- Set by account.application.deauthorized; cleared when the artist connects a new account.
ALTER TABLE artist_tip_accounts ADD COLUMN IF NOT EXISTS deauthorized_at timestamptz;

-- ---------------------------------------------------------------------------------------------
-- 3. Goals per Stripe mode
-- ---------------------------------------------------------------------------------------------
ALTER TABLE artist_goals ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------------------------
-- Aggregates, now net of refunds. Same rules as before otherwise: this mode only, succeeded
-- payments only, so a full refund or an open or lost dispute drops out entirely.
-- ---------------------------------------------------------------------------------------------

-- Same signature and return shape as before (the artist page edge function calls it directly).
-- A partial refund leaves the ledger entry as written — support_entries is append-only and voiding
-- is all-or-nothing — and the refunded share is taken off here, from its payment.
CREATE OR REPLACE FUNCTION public.get_goal_progress(p_goal_ids uuid[], p_livemode boolean)
RETURNS TABLE(goal_id uuid, raised_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT e.goal_id,
         sum(e.amount_cents - round(e.amount_cents::numeric * p.refunded_cents / p.gross_cents))::bigint
  FROM support_entries e
  JOIN tip_payments p ON p.id = e.payment_id
  WHERE e.goal_id = ANY(p_goal_ids)
    AND e.voided_at IS NULL
    AND p.status = 'succeeded'
    AND p.livemode = p_livemode
  GROUP BY e.goal_id;
$function$;

-- The return type gains refunded_cents, which CREATE OR REPLACE can't do, hence the DROP. Columns:
--   gross_cents            what fans were charged (Stripe's fee is estimated on this)
--   refunded_cents         how much of that was refunded
--   amount_cents           what the artist was tipped, less the refunded share
--   application_fee_cents  Unstream's fee, less the share handed back on refunds (tips-webhook)
DROP FUNCTION IF EXISTS public.get_artist_tip_totals(uuid, boolean, timestamptz);
CREATE FUNCTION public.get_artist_tip_totals(p_artist_id uuid, p_livemode boolean, p_since timestamptz)
RETURNS TABLE(payment_count bigint, gross_cents bigint, amount_cents bigint, application_fee_cents bigint, refunded_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT count(*)::bigint,
         COALESCE(sum(p.gross_cents), 0)::bigint,
         COALESCE(sum(p.amount_cents - round(p.amount_cents::numeric * p.refunded_cents / p.gross_cents)), 0)::bigint,
         COALESCE(sum(p.application_fee_cents - round(p.application_fee_cents::numeric * p.refunded_cents / p.gross_cents)), 0)::bigint,
         COALESCE(sum(p.refunded_cents), 0)::bigint
  FROM tip_payments p
  WHERE p.artist_id = p_artist_id
    AND p.livemode = p_livemode
    AND p.status = 'succeeded'
    AND (p_since IS NULL OR p.created_at >= p_since);
$function$;

-- CLAUDE.md, security practices: revoke from all three, rely on the service role. Repeated for
-- get_goal_progress although CREATE OR REPLACE keeps its grants, so this file stands on its own.
REVOKE EXECUTE ON FUNCTION public.get_goal_progress(uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_goal_progress(uuid[], boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_artist_tip_totals(uuid, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_artist_tip_totals(uuid, boolean, timestamptz) TO service_role;
