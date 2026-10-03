/**
 * The Phase 3 gate for artist patronage (docs/specs/artist-patronage-spec.md §4 "Saved cards";
 * write-up in docs/specs/artist-patronage-phase3-gate.md). Answers, in Stripe TEST MODE only:
 *
 *   1. Can a PaymentMethod saved on the platform be cloned to a Standard connected account and
 *      charged off-session there, as a direct charge?
 *   2. Can a cloned PaymentMethod be charged twice without a Customer on the connected account —
 *      i.e. does the tab need a (fan, artist) → connected-Customer table, or can each monthly run
 *      clone afresh?
 *   3. What does a card that needs authentication (SCA) return off-session?
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_… npx tsx scripts/stripe-verify-clone.ts acct_…
 *
 * acct_… must be a TEST-mode Standard account connected to this platform with charges enabled —
 * e.g. one created through the dashboard's "Connect Stripe" with Stripe's test onboarding data.
 *
 * Refuses anything but an sk_test_ key. Touches no database. Every object it creates is test data.
 */

import { stripeRequest, StripeError } from '../api/functions/stripe';

interface Obj { id: string; status?: string; [k: string]: unknown }

async function main() {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!key.startsWith('sk_test_')) {
    console.error('Refusing to run: STRIPE_SECRET_KEY must be a test-mode key (sk_test_…).');
    process.exit(1);
  }
  const account = process.argv[2];
  if (!account?.startsWith('acct_')) {
    console.error('Usage: npx tsx scripts/stripe-verify-clone.ts acct_<test connected account>');
    process.exit(1);
  }

  const results: Array<[string, string]> = [];
  const record = (label: string, outcome: string) => { results.push([label, outcome]); console.log(`${label}: ${outcome}`); };

  // The fan's card, saved on the platform — what setup-mode Checkout would leave behind.
  const customer = await stripeRequest<Obj>('POST', '/v1/customers', { description: 'Phase 3 gate: test fan' });
  const saveCard = async (token: string) => {
    const pm = await stripeRequest<Obj>('POST', '/v1/payment_methods', { type: 'card', card: { token } });
    await stripeRequest('POST', `/v1/payment_methods/${pm.id}/attach`, { customer: customer.id });
    return pm.id;
  };
  const platformPm = await saveCard('tok_visa');

  const clone = (pm: string, connectedCustomer?: string) =>
    stripeRequest<Obj>('POST', '/v1/payment_methods', { customer: customer.id, payment_method: pm }, { stripeAccount: account })
      .then(async cloned => {
        if (connectedCustomer) {
          await stripeRequest('POST', `/v1/payment_methods/${cloned.id}/attach`, { customer: connectedCustomer }, { stripeAccount: account });
        }
        return cloned.id;
      });

  const charge = (pm: string, label: string, connectedCustomer?: string) =>
    stripeRequest<Obj>('POST', '/v1/payment_intents', {
      amount: 300,
      currency: 'usd',
      payment_method: pm,
      customer: connectedCustomer,
      confirm: true,
      off_session: true,
      description: 'Phase 3 gate: test charge',
    }, { stripeAccount: account, idempotencyKey: `gate:${label}:${Date.now()}` })
      .then(pi => `status=${pi.status} (${pi.id})`)
      .catch(err => (err instanceof StripeError ? `ERROR ${err.code ?? err.type ?? err.status}: ${err.message}` : `ERROR ${String(err)}`));

  // 1. Clone and charge once, off-session, as a direct charge.
  const cloned = await clone(platformPm).catch(err => { record('1. clone to connected account', `ERROR ${err.message}`); return null; });
  if (cloned) {
    record('1. clone to connected account', `ok (${cloned})`);
    record('1. off-session direct charge of the clone', await charge(cloned, 'first'));
    // 2a. The same clone again, with no connected-account Customer.
    record('2a. second charge of the same clone, no connected Customer', await charge(cloned, 'second'));
  }

  // 2b. A fresh clone per charge (what a monthly run could do instead of storing anything).
  const fresh = await clone(platformPm).catch(() => null);
  record('2b. fresh clone, charged', fresh ? await charge(fresh, 'fresh') : 'ERROR clone failed');

  // 2c. Clone attached to a connected-account Customer, charged twice.
  const connectedCustomer = await stripeRequest<Obj>('POST', '/v1/customers', { description: 'Phase 3 gate: fan on artist account' }, { stripeAccount: account });
  const attached = await clone(platformPm, connectedCustomer.id).catch(() => null);
  if (attached) {
    record('2c. clone on a connected Customer, first charge', await charge(attached, 'cust-1', connectedCustomer.id));
    record('2c. clone on a connected Customer, second charge', await charge(attached, 'cust-2', connectedCustomer.id));
  } else {
    record('2c. clone on a connected Customer', 'ERROR clone/attach failed');
  }

  // 3. A card that requires authentication, off-session.
  const scaPm = await saveCard('tok_threeDSecure2Required').catch(() => null);
  const scaClone = scaPm ? await clone(scaPm).catch(() => null) : null;
  record('3. SCA card, off-session', scaClone ? await charge(scaClone, 'sca') : 'ERROR could not save/clone the SCA test card');

  console.log('\nPaste this into docs/specs/artist-patronage-phase3-gate.md:\n');
  for (const [label, outcome] of results) console.log(`| ${label} | ${outcome} |`);
}

main().catch(err => {
  console.error(err instanceof StripeError ? `Stripe ${err.status} ${err.code ?? ''}: ${err.message}` : err);
  process.exit(1);
});
