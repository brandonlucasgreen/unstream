import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { GoalProgress } from './GoalProgress';
import { useResetOnPageShow } from '../hooks/useResetOnPageShow';
import { formatUsd, tipBreakdown } from '../../../../api/shared/tips';
import type { TipPageData } from '../services/tips';

// The tip itself (docs/specs/artist-patronage-spec.md §3.1, §5): an amount, an optional goal and the
// cover-the-fees checkbox, with the breakdown shown before paying. Shared by the /tip/{slug} page and
// the tip window on search results and the artist page. The server re-checks everything and creates
// the payment, and Stripe's own page takes the card — no Stripe.js, no card fields here.

export function TipForm({ data, initialGoalId = '' }: { data: TipPageData; initialGoalId?: string }) {
  const { session } = useAuth();
  // Only open goals are offered, so a `?goal=` that isn't one of them (closed, mistyped, another
  // artist's) starts with no goal rather than a selection the fan can't see.
  const openGoals = (data.goals ?? []).filter(goal => goal.status === 'open');
  const [amountCents, setAmountCents] = useState(1000);
  const [custom, setCustom] = useState('');
  const [coverFees, setCoverFees] = useState(true);
  const [goalId, setGoalId] = useState<string>(
    openGoals.some(goal => goal.id === initialGoalId) ? initialGoalId : '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Back from Stripe's page can restore this one from the back/forward cache, still "Opening Stripe…".
  useResetOnPageShow(() => setSubmitting(false));

  const minCents = data.minCents ?? 300;
  const maxCents = data.maxCents ?? 50000;
  const customCents = custom.trim() === '' ? null : Math.round(Number(custom) * 100);
  const chosenCents = customCents ?? amountCents;
  const amountValid = Number.isInteger(chosenCents) && chosenCents >= minCents && chosenCents <= maxCents;
  const breakdown = useMemo(
    () => (amountValid ? tipBreakdown(chosenCents, coverFees, data.feeBasisPoints ?? 0) : null),
    [amountValid, chosenCents, coverFees, data.feeBasisPoints],
  );

  const pay = async () => {
    if (!amountValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (session) headers.Authorization = `Bearer ${session.access_token}`;
      const r = await fetch('/api/tips/checkout', {
        method: 'POST',
        headers,
        body: JSON.stringify({ artistSlug: data.artist.slug, amountCents: chosenCents, coverFees, goalId: goalId || undefined }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.url) {
        setSubmitError(body.error ?? "Couldn't start the payment. Try again.");
        setSubmitting(false);
        return;
      }
      window.location.href = body.url;
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'TipForm.pay' } });
      setSubmitError("Couldn't start the payment. Try again.");
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="text-sm font-medium mb-2">Amount</legend>
        <div className="grid grid-cols-3 gap-2">
          {(data.presetsCents ?? [500, 1000, 2000]).map(cents => (
            <button
              key={cents}
              type="button"
              aria-pressed={customCents === null && amountCents === cents}
              onClick={() => { setAmountCents(cents); setCustom(''); }}
              className={`min-h-11 rounded-lg border text-sm font-medium transition-colors ${
                customCents === null && amountCents === cents
                  ? 'border-accent-primary bg-accent-primary/10 text-accent-primary'
                  : 'border-border hover:bg-bg-hover'
              }`}
            >
              {formatUsd(cents).replace('.00', '')}
            </button>
          ))}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <span className="text-text-muted">Other amount ($)</span>
          <input
            type="number"
            inputMode="decimal"
            min={minCents / 100}
            max={maxCents / 100}
            step="0.01"
            value={custom}
            onChange={e => setCustom(e.target.value)}
            placeholder={(minCents / 100).toFixed(0) + ' or more'}
            className="flex-1 min-w-0 px-3 py-2 bg-bg-secondary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
          />
        </label>
        {!amountValid && (
          <p className="mt-1 text-xs text-red-400">
            Tips are between {formatUsd(minCents)} and {formatUsd(maxCents)}. Under {formatUsd(minCents)}, card fees take too much of it.
          </p>
        )}
      </fieldset>

      {openGoals.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Put it towards a goal? (optional)</legend>
          {openGoals.map(goal => (
            <label key={goal.id} className={`block p-3 rounded-lg border cursor-pointer ${goalId === goal.id ? 'border-accent-primary' : 'border-border'}`}>
              <input
                type="radio"
                name="goal"
                className="sr-only"
                checked={goalId === goal.id}
                onChange={() => setGoalId(goal.id)}
              />
              <GoalProgress goal={goal} />
            </label>
          ))}
          {goalId && (
            <button type="button" onClick={() => setGoalId('')} className="text-xs text-text-muted hover:text-text-secondary">
              No goal, just a tip
            </button>
          )}
          <p className="text-xs text-text-muted">
            Tips go to {data.artist.name} straight away, whether or not the goal is met.
          </p>
        </fieldset>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={coverFees} onChange={e => setCoverFees(e.target.checked)} className="mt-1" />
        <span>Cover the fees, so {data.artist.name} gets the full amount</span>
      </label>

      {breakdown && (
        <p className="text-sm text-text-secondary">
          You pay <strong className="text-text-primary">{formatUsd(breakdown.grossCents)}</strong>
          {' · '}Stripe keeps ~{formatUsd(breakdown.stripeFeeCents)}
          {' · '}Unstream keeps {formatUsd(breakdown.applicationFeeCents)}
          {' · '}{data.artist.name} gets ~{formatUsd(breakdown.artistNetCents)}
        </p>
      )}

      {submitError && <p className="text-sm text-red-400">{submitError}</p>}

      <button
        type="button"
        onClick={pay}
        disabled={!amountValid || submitting}
        className="w-full min-h-11 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 disabled:opacity-50"
      >
        {submitting ? 'Opening Stripe…' : breakdown ? `Pay ${formatUsd(breakdown.grossCents)} with Stripe` : 'Pay with Stripe'}
      </button>
      <p className="text-xs text-text-muted text-center">
        {data.artist.name} is the seller and receives the payment directly. Refunds are handled by the artist.{' '}
        <Link to="/terms#section-14" className="underline">How tipping works</Link>
      </p>
    </div>
  );
}
