import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { useAuth } from '../contexts/AuthContext';
import {
  costTotals,
  coveragePercent,
  fetchLedger,
  fetchLive,
  fetchMyMembership,
  formatUsd,
  openMembershipPortal,
  startCheckout,
  type Ledger,
  type MyMembership,
  type OpenStudioLive,
  type PurchasablePlan,
} from '../services/openStudio';

// /open-studio — what Unstream costs to run, what members cover, and where the surplus goes.
// Spec: docs/specs/open-studio-membership-spec.md §5. The numbers do the persuading; the
// membership is sold on the bill, not on the perks.

const PLANS: { plan: PurchasablePlan; price: string; per: string; note: string }[] = [
  { plan: 'monthly', price: '$3', per: 'a month', note: 'Cancel any time.' },
  { plan: 'annual', price: '$25', per: 'a year', note: 'Less of it goes to card fees.' },
  { plan: 'lifetime', price: '$100', per: 'once', note: 'For people who hate subscriptions.' },
];

export function OpenStudioPage() {
  const { session, isLoading: authLoading } = useAuth();
  const [searchParams] = useSearchParams();
  const justJoined = searchParams.get('membership') === 'thanks';

  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ledgerFailed, setLedgerFailed] = useState(false);
  const [live, setLive] = useState<OpenStudioLive | null>(null);
  const [liveFailed, setLiveFailed] = useState(false);
  const [membership, setMembership] = useState<MyMembership | null>(null);
  const [pending, setPending] = useState<PurchasablePlan | 'portal' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    fetchLedger()
      .then(setLedger)
      .catch((error) => {
        Sentry.captureException(error, { extra: { context: 'open-studio.ledger' } });
        setLedgerFailed(true);
      });
    fetchLive()
      .then(setLive)
      .catch(() => setLiveFailed(true));
  }, []);

  const accessToken = session?.access_token;
  useEffect(() => {
    if (!accessToken) {
      setMembership(null);
      return;
    }
    fetchMyMembership(accessToken)
      .then(setMembership)
      // Unknown isn't "not a member": leave it null, which hides both the ask and "manage".
      .catch(() => setMembership(null));
  }, [accessToken]);

  async function go(action: PurchasablePlan | 'portal') {
    if (!accessToken) return;
    setPending(action);
    setActionError(null);
    try {
      const url = action === 'portal'
        ? await openMembershipPortal(accessToken)
        : await startCheckout(accessToken, action);
      window.location.href = url;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Something went wrong');
      setPending(null);
    }
  }

  const totals = ledger ? costTotals(ledger.costs) : null;
  const coverage = totals && live ? coveragePercent(live.monthlyRecurringCents, totals.full) : null;

  return (
    <div className="min-h-screen">
      <Header />

      <div className="pt-8 pb-4 px-4">
        <div className="max-w-2xl mx-auto">
          <h1 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-4">Open Studio</h1>
          <p className="text-text-secondary text-lg">
            The doors are open: what Unstream costs to run, what members cover, and where
            anything left over goes. Search, support links, saved artists and the apps stay free
            whether or not anyone pays.
          </p>
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto space-y-10">
          {justJoined && (
            <div className="rounded-xl border border-border bg-surface-secondary p-4 text-text-primary" role="status">
              Thank you. Your membership can take a minute to show up here while Stripe confirms it.
            </div>
          )}

          {ledger?.draft && (
            <p className="rounded-xl border border-border p-4 text-sm text-text-muted">
              Draft figures, not yet checked against real invoices.
            </p>
          )}

          {/* The bill */}
          <section aria-labelledby="bill-heading">
            <h2 id="bill-heading" className="font-display text-xl font-semibold text-text-primary mb-4">The monthly bill</h2>
            {ledgerFailed && <p className="text-text-muted">The bill couldn’t be loaded. Try again in a moment.</p>}
            {ledger && totals && (
              <>
                <ul className="divide-y divide-border border-y border-border">
                  {ledger.costs.map((cost) => (
                    <li key={cost.item} className="py-3 flex gap-4 justify-between">
                      <div>
                        <p className="text-text-primary font-medium">{cost.item}</p>
                        <p className="text-text-secondary text-sm">{cost.why}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-text-primary tabular-nums">{formatUsd(cost.monthly)}</p>
                        {!cost.paying && <p className="text-text-muted text-xs">free tier today</p>}
                      </div>
                    </li>
                  ))}
                </ul>
                <dl className="mt-4 grid grid-cols-2 gap-4">
                  <div>
                    <dt className="text-text-muted text-sm">Paying today</dt>
                    <dd className="text-text-primary text-2xl font-semibold tabular-nums">{formatUsd(totals.current)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted text-sm">Off the free tiers</dt>
                    <dd className="text-text-primary text-2xl font-semibold tabular-nums">{formatUsd(totals.full)}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-text-muted text-sm">Updated {ledger.updated}. Per month; yearly costs divided by twelve.</p>
              </>
            )}
          </section>

          {/* What members cover */}
          <section aria-labelledby="cover-heading">
            <h2 id="cover-heading" className="font-display text-xl font-semibold text-text-primary mb-4">What members cover</h2>
            {liveFailed && <p className="text-text-muted">Live figures are unavailable right now.</p>}
            {live?.belowThreshold && (
              <p className="text-text-secondary">
                Fewer than 5 members so far. Totals appear once there are enough that nobody’s payment
                can be worked out from them.
              </p>
            )}
            {live && !live.belowThreshold && totals && (
              <>
                <p className="text-text-secondary mb-3">
                  {live.activeMembers} members, {formatUsd((live.monthlyRecurringCents ?? 0) / 100)} a month in
                  recurring support{coverage !== null ? ` — ${coverage}% of the full bill` : ''}.
                </p>
                {coverage !== null && (
                  <div
                    className="h-3 rounded-full bg-surface-secondary overflow-hidden"
                    role="img"
                    aria-label={`${coverage}% of the monthly bill covered`}
                  >
                    <div className="h-full bg-accent-primary" style={{ width: `${Math.min(coverage, 100)}%` }} />
                  </div>
                )}
              </>
            )}
            <p className="mt-3 text-text-muted text-sm">
              Updated hourly. Lifetime memberships count as members but not as monthly income; they
              show up in the month they arrived.
            </p>
          </section>

          {/* Join / manage */}
          <section aria-labelledby="join-heading" className="rounded-2xl border border-border bg-surface-secondary p-6">
            <h2 id="join-heading" className="font-display text-xl font-semibold text-text-primary mb-2">
              {membership?.active ? 'You’re a member' : 'Become a member'}
            </h2>

            {membership?.active ? (
              <>
                <p className="text-text-secondary mb-4">Thank you. It genuinely keeps the lights on.</p>
                {membership.canManage && (
                  <button
                    type="button"
                    onClick={() => go('portal')}
                    disabled={pending !== null}
                    className="px-4 py-2 rounded-lg border border-border text-text-primary hover:bg-bg-hover disabled:opacity-50"
                  >
                    {pending === 'portal' ? 'Opening…' : 'Manage membership'}
                  </button>
                )}
              </>
            ) : (
              <>
                <p className="text-text-secondary mb-4">
                  Optional, low-stakes, and it gates nothing. Members get a badge on their profile,
                  early betas and a vote on the roadmap.
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  {PLANS.map(({ plan, price, per, note }) => (
                    <div key={plan} className="rounded-xl border border-border bg-bg-card p-4 flex flex-col">
                      <p className="text-text-primary text-2xl font-semibold">{price}</p>
                      <p className="text-text-muted text-sm mb-2">{per}</p>
                      <p className="text-text-secondary text-sm mb-4 flex-1">{note}</p>
                      {session ? (
                        <button
                          type="button"
                          onClick={() => go(plan)}
                          disabled={pending !== null || authLoading}
                          className="px-3 py-2 rounded-lg bg-accent-primary text-white font-medium hover:opacity-90 disabled:opacity-50"
                        >
                          {pending === plan ? 'Opening…' : 'Join'}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
                {!session && !authLoading && (
                  <p className="mt-4 text-text-secondary">
                    <Link to="/login" className="text-accent-primary hover:underline">Sign in</Link> to
                    become a member. It links the membership to your account, so Unstream never has to
                    store your email or card.
                  </p>
                )}
                <p className="mt-4 text-text-muted text-sm">
                  Payments are handled by Stripe, which keeps roughly 16% of a $3 charge and 8% of a $25
                  one, and handles sales tax and VAT. Past months list exactly what it kept.
                </p>
              </>
            )}
            {actionError && <p className="mt-3 text-sm text-red-500" role="alert">{actionError}</p>}
          </section>

          {/* Surplus */}
          <section aria-labelledby="surplus-heading">
            <h2 id="surplus-heading" className="font-display text-xl font-semibold text-text-primary mb-2">Where the surplus goes</h2>
            <p className="text-text-secondary">
              To me, Brandon — an indie musician who builds this on evenings and weekends. If members
              ever cover more than the bill, that’s where the rest goes, and this page will say how much.
            </p>
          </section>

          {ledger && ledger.months.length > 0 && (
            <section aria-labelledby="months-heading">
              <h2 id="months-heading" className="font-display text-xl font-semibold text-text-primary mb-4">Past months</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead className="text-text-muted text-left">
                    <tr>
                      <th className="py-2 pr-4 font-normal">Month</th>
                      <th className="py-2 pr-4 font-normal text-right">Costs</th>
                      <th className="py-2 pr-4 font-normal text-right">Fees</th>
                      <th className="py-2 pr-4 font-normal text-right">Income</th>
                      <th className="py-2 font-normal text-right">Net</th>
                    </tr>
                  </thead>
                  <tbody className="text-text-primary">
                    {ledger.months.map((m) => {
                      const income = m.memberRevenue + m.tipFeeRevenue + m.otherRevenue;
                      return (
                        <tr key={m.month} className="border-t border-border">
                          <td className="py-2 pr-4">{m.month}</td>
                          <td className="py-2 pr-4 text-right">{formatUsd(m.costs)}</td>
                          <td className="py-2 pr-4 text-right">{formatUsd(m.processingFees)}</td>
                          <td className="py-2 pr-4 text-right">{formatUsd(income)}</td>
                          <td className="py-2 text-right">{formatUsd(income - m.costs - m.processingFees)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
