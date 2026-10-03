import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArtistTipsAddendum } from './ArtistTipsAddendum';
import { TipGoalsEditor } from './TipGoalsEditor';
import { connectStripe, updateTipSettings, type TipSettings } from '../services/tips';
import { formatUsd, tipBreakdown } from '../../../../api/shared/tips';

// The Manage Tips tab's content (docs/specs/artist-patronage-spec.md §8, states 2–5). ArtistTipsPage
// loads the settings and hands them in; this renders them and saves changes.

const FEE_OPTIONS = [0, 100, 200, 300, 400, 500];
const OTHER_COUNTRY = 'other';

export function ArtistTipsPanel({ slug, token, settings, onChange }: {
  slug: string;
  token: string;
  settings: TipSettings;
  onChange: (settings: TipSettings) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const goToStripe = async (opts: { country?: string; acceptAddendum?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      window.location.href = await connectStripe(token, slug, opts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach Stripe");
      setBusy(false);
    }
  };
  const update = async (patch: { tipsEnabled?: boolean; feeBasisPoints?: number }) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await updateTipSettings(token, slug, patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {!settings.livemode && (
        <p className="text-xs text-yellow-600">Stripe test mode: no real money moves.</p>
      )}
      {settings.foreignAccount ? (
        <p className="text-sm text-text-secondary">
          This profile has a Stripe account connected by a previous owner. Email support@unstream.stream and we'll sort it out.
        </p>
      ) : settings.state === 'not_connected' ? (
        <ConnectForm countries={settings.countries} busy={busy} onConnect={goToStripe} />
      ) : settings.state === 'stripe_review' ? (
        <div className="space-y-2 text-sm">
          <p>Stripe has your details and is checking them. That usually takes a few minutes, sometimes a day or two.</p>
          <p className="text-text-secondary">There's nothing you need to do. Stripe emails you if it needs anything, and this page updates once it's done.</p>
        </div>
      ) : settings.state === 'stripe_declined' ? (
        <div className="space-y-2 text-sm">
          <p>Stripe didn't approve this account, so it can't take payments.</p>
          <a href="https://dashboard.stripe.com/" target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">
            See why in your Stripe dashboard →
          </a>
        </div>
      ) : settings.state === 'onboarding' ? (
        <div className="space-y-2">
          <p className="text-sm">Stripe needs a few more details before fans can tip you.</p>
          <button type="button" disabled={busy} onClick={() => goToStripe({})} className="px-3 py-2 text-sm rounded-lg bg-accent-primary text-white disabled:opacity-50">
            Continue on Stripe
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {settings.state === 'awaiting_approval' && (
            <p className="text-sm text-text-secondary">
              Stripe is connected. We check each artist's first setup by hand, so it's clear the account belongs to you —
              usually within a day. You can get everything ready meanwhile.
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.tipsEnabled} disabled={busy} onChange={e => update({ tipsEnabled: e.target.checked })} />
            Take tips on Unstream
            {settings.tipsEnabled && settings.state === 'awaiting_approval' && <span className="text-text-muted">(live once approved)</span>}
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            Unstream's share
            <select
              value={settings.feeBasisPoints}
              disabled={busy}
              onChange={e => update({ feeBasisPoints: Number(e.target.value) })}
              className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
            >
              {FEE_OPTIONS.map(bps => <option key={bps} value={bps}>{bps / 100}%{bps === 0 ? ' (default)' : ''}</option>)}
            </select>
            <span className="text-text-muted text-xs">Optional, and shown to fans before they pay.</span>
          </label>

          {settings.totals && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Totals label="This month" totals={settings.totals.month} />
              <Totals label="All time" totals={settings.totals.allTime} />
            </div>
          )}

          <TipGoalsEditor token={token} slug={slug} goals={settings.goals} onChange={goals => onChange({ ...settings, goals })} />

          <div className="flex flex-wrap gap-3 text-sm">
            <Link to={`/tip/${slug}`} className="text-accent-primary hover:underline">See what fans see</Link>
            <a href="https://dashboard.stripe.com/" target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">
              Payouts, refunds and receipts in Stripe →
            </a>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

function Totals({ label, totals }: { label: string; totals: { count: number; grossCents: number; netCents: number } }) {
  return (
    <div>
      <p className="text-text-muted text-xs">{label}</p>
      <p className="font-semibold">{totals.count} {totals.count === 1 ? 'tip' : 'tips'}</p>
      <p className="text-text-secondary text-xs">{formatUsd(totals.grossCents)} paid · ~{formatUsd(Math.max(0, totals.netCents))} to you</p>
    </div>
  );
}

function ConnectForm({ countries, busy, onConnect }: {
  countries: Record<string, string>;
  busy: boolean;
  onConnect: (opts: { country: string; acceptAddendum: boolean }) => void;
}) {
  const [country, setCountry] = useState('US');
  const [accepted, setAccepted] = useState(false);
  const example = tipBreakdown(500, false, 0);
  const sorted = Object.entries(countries).sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div className="space-y-3 text-sm">
      <p>
        Let fans tip you from Unstream, straight into your own Stripe account. You're the seller; Unstream never holds the money.
      </p>
      <table className="text-xs text-text-secondary">
        <tbody>
          <tr><td className="pr-3">A {formatUsd(example.amountCents)} tip</td><td>Stripe keeps ~{formatUsd(example.stripeFeeCents)} (2.9% + 30¢)</td></tr>
          <tr><td className="pr-3">Unstream</td><td>0% by default; you can choose to share up to 5%</td></tr>
          <tr><td className="pr-3">Fans</td><td>can cover the fees, so you get the full amount</td></tr>
        </tbody>
      </table>
      <label className="flex flex-wrap items-center gap-2">
        Where you're based
        <select value={country} onChange={e => setCountry(e.target.value)} className="px-2 py-1 bg-bg-primary border border-border rounded-lg">
          {sorted.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          <option value={OTHER_COUNTRY}>Somewhere else</option>
        </select>
      </label>
      {country === OTHER_COUNTRY ? (
        <p className="text-text-secondary">
          Stripe isn't available in your country yet, so tips through Unstream aren't either. You can still add Ko-fi, Patreon or
          Liberapay to your profile from the Edit page, and fans will find them there.
        </p>
      ) : (
        <>
          <ArtistTipsAddendum />
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-1" />
            I agree to these terms for taking tips.
          </label>
          <button
            type="button"
            disabled={busy || !accepted}
            onClick={() => onConnect({ country, acceptAddendum: true })}
            className="px-3 py-2 rounded-lg bg-accent-primary text-white disabled:opacity-50"
          >
            {busy ? 'Opening Stripe…' : 'Connect Stripe'}
          </button>
        </>
      )}
    </div>
  );
}
