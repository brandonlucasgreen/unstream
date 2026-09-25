/**
 * Grant a grandfathered Open House membership by hand.
 *
 * For Liberapay patrons and iOS tip-jar tippers, who paid before memberships existed and
 * have no Stripe objects behind them (docs/specs/open-house-membership-spec.md §9). The
 * honour system is fine at this scale.
 *
 * Usage:
 *   npx tsx scripts/grant-membership.ts <email>            # grant
 *   npx tsx scripts/grant-membership.ts <email> --revoke   # take a grandfathered grant back
 *
 * The person must already have an Unstream account (they sign in first). Refuses to touch
 * anyone who is paying through Stripe — the webhook owns those rows.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY env vars (or .env file). This writes to
 * PRODUCTION.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Set them in .env or environment.');
  process.exit(1);
}

const supabase = createClient(url, key);
const [, , emailArg, flag] = process.argv;

async function findUserId(email: string): Promise<string | null> {
  // The admin API has no lookup by email, so page through users. Fine at Unstream's size.
  const target = email.trim().toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const match = data.users.find((user) => user.email?.toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < 1000) return null;
  }
}

async function main() {
  if (!emailArg || (flag && flag !== '--revoke')) {
    console.error('Usage: npx tsx scripts/grant-membership.ts <email> [--revoke]');
    process.exit(1);
  }

  const userId = await findUserId(emailArg);
  if (!userId) {
    console.error('No Unstream account with that email. Ask them to sign in once first.');
    process.exit(1);
  }

  const { data: existing, error: readError } = await supabase
    .from('memberships')
    .select('plan, status')
    .eq('user_id', userId)
    .maybeSingle();
  if (readError) throw new Error(`read failed: ${readError.message}`);

  if (existing && existing.plan !== 'grandfathered' && existing.status !== 'canceled') {
    console.error(`User ${userId} already pays (${existing.plan}, ${existing.status}); leaving it alone.`);
    process.exit(1);
  }

  if (flag === '--revoke') {
    if (existing?.plan !== 'grandfathered') {
      console.error(`User ${userId} has no grandfathered grant to revoke.`);
      process.exit(1);
    }
    const { error } = await supabase.from('memberships').delete().eq('user_id', userId);
    if (error) throw new Error(`delete failed: ${error.message}`);
    console.log(`Revoked grandfathered membership for user ${userId}.`);
    return;
  }

  const { error } = await supabase.from('memberships').upsert(
    {
      user_id: userId,
      plan: 'grandfathered',
      status: 'active',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      amount_cents: null,
      currency: null,
      current_period_end: null,
      canceled_at: null,
    },
    { onConflict: 'user_id' }
  );
  if (error) throw new Error(`upsert failed: ${error.message}`);
  console.log(`Granted grandfathered membership to user ${userId}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
