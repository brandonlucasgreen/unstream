-- Migration: Open House memberships
--
-- One row per member: the optional supporter membership that replaces the Liberapay link
-- (docs/specs/open-house-membership-spec.md §8). Stripe Managed Payments is the merchant of
-- record and holds everything about the buyer — email, name, card, tax location. This table
-- holds only what Unstream needs to answer two questions: "is this user a member?" (badge,
-- betas, never hiding the ask from someone who already gave) and "how many members, paying
-- what?" (the aggregate on /open-house).
--
-- SERVER-ONLY: RLS is enabled with NO policies, deliberately. Every read and write goes
-- through the service-role client in Netlify functions (me-membership, membership-webhook,
-- open-house), which bypasses RLS; anon and authenticated get nothing. A signed-in user reads
-- their own status via /api/me/membership, never from the table directly.
--
-- One row per user, keyed on user_id: you are a member or you aren't. Plan changes, renewals
-- and cancellations update the row in place, and every webhook handler writes absolute state
-- from the Stripe object it received, so a replayed or out-of-order event is harmless and no
-- separate idempotency table is needed.
--
-- ON DELETE CASCADE removes the row with the auth user, but it does NOT cancel the Stripe
-- subscription. There is no self-serve account deletion today; if an account is ever deleted
-- by hand, cancel its subscription in the Stripe dashboard first.

CREATE TABLE IF NOT EXISTS public.memberships (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 'grandfathered' is granted by hand (scripts/grant-membership.ts) to Liberapay patrons and
  -- iOS tip-jar tippers, and has no Stripe objects behind it.
  plan TEXT NOT NULL CHECK (plan IN ('monthly', 'annual', 'lifetime', 'grandfathered')),

  -- past_due keeps perks for a grace period while Stripe retries the card; see membership.ts.
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled')),

  -- Null for grandfathered rows. Unique so a webhook can find the row from a Stripe object.
  stripe_customer_id TEXT UNIQUE,
  -- Null for lifetime and grandfathered rows, which have no subscription.
  stripe_subscription_id TEXT UNIQUE,

  -- What the member pays per period, in the smallest currency unit. Only for the aggregate on
  -- /open-house; null for grandfathered rows, which pay nothing through Stripe.
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency TEXT,

  -- End of the paid-up period. Null means it doesn't expire (lifetime, grandfathered).
  current_period_end TIMESTAMPTZ,

  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  canceled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The /open-house aggregate reads every non-canceled row; a partial index keeps that a tiny
-- scan however many canceled rows accumulate.
CREATE INDEX IF NOT EXISTS idx_memberships_live
  ON public.memberships(status) WHERE status <> 'canceled';

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
-- No policies: see the header. Their absence is the access model, not an oversight.

DROP TRIGGER IF EXISTS memberships_updated_at ON public.memberships;
CREATE TRIGGER memberships_updated_at
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE public.memberships IS
  'Open House memberships. Server-only: RLS on, no policies. Stripe holds all buyer PII.';
