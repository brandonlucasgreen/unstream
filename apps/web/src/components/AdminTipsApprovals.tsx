import { useCallback, useEffect, useState } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';

// Tips approval on /admin/verify (docs/specs/artist-patronage-spec.md §6, gate 3). Compare the
// claimed artist with the Stripe account's business name and country before approving: this is
// the defence against someone claiming a profile and collecting an artist's tips.

interface PendingAccount {
  artistId: string;
  artistName: string | null;
  artistSlug: string | null;
  claimEmail: string | null;
  claimVerified: boolean;
  connectedByCurrentOwner: boolean;
  stripeAccountId: string;
  stripe: { businessName: string | null; country: string | null; email: string | null; error?: string };
  state: string;
  chargesEnabled: boolean;
  tipsEnabled: boolean;
  approvedAt: string | null;
  feeBasisPoints: number;
}

export function AdminTipsApprovals() {
  const { session } = useAuth();
  const [data, setData] = useState<{ available: boolean; livemode?: boolean; accounts: PendingAccount[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!session) return;
    fetch('/api/admin/tips', { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch(err => {
        Sentry.captureException(err, { extra: { context: 'AdminTipsApprovals.load' } });
        setError("Couldn't load tips accounts");
      });
  }, [session]);

  useEffect(load, [load]);

  const act = async (account: PendingAccount, action: 'approve' | 'revoke') => {
    if (!session) return;
    setBusy(account.artistId);
    setError(null);
    try {
      const r = await fetch('/api/admin/tips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action, artistId: account.artistId, stripeAccountId: account.stripeAccountId }),
      });
      // The server explains a refusal (a 409 when charges aren't enabled or the profile changed hands).
      if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (HTTP ${r.status})`);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: `AdminTipsApprovals.${action}` } });
      setError(`Couldn't ${action === 'approve' ? 'approve' : 'switch tips off'}: the request didn't reach the server. Try again.`);
    } finally {
      setBusy(null);
    }
    load();
  };

  if (!data?.available) return error ? <p className="text-sm text-red-400">{error}</p> : null;

  return (
    <section className="space-y-4">
      <h2 className="font-display text-lg font-semibold text-text-primary">
        Tips accounts {!data.livemode && <span className="text-sm font-normal text-yellow-600">(Stripe test mode)</span>}
      </h2>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {data.accounts.length === 0 && <p className="text-sm text-text-muted">No artist has connected Stripe yet.</p>}
      {data.accounts.map(a => (
        <div key={a.artistId} className="p-4 rounded-lg border border-border bg-bg-secondary space-y-2 text-sm">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-text-muted uppercase">Claimed artist</p>
              <p className="font-semibold">{a.artistName}</p>
              {a.artistSlug && <a href={`/a/${a.artistSlug}`} target="_blank" rel="noreferrer" className="text-accent-primary text-xs">/a/{a.artistSlug}</a>}
              <p className="text-xs text-text-muted">Claim email: {a.claimEmail ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-text-muted uppercase">Stripe account</p>
              <p className="font-semibold">{a.stripe.businessName ?? '(no business name yet)'}</p>
              <p className="text-xs text-text-muted">{a.stripe.country ?? '—'} · {a.stripe.email ?? '—'} · {a.stripeAccountId}</p>
              {a.stripe.error && <p className="text-xs text-red-400">Stripe: {a.stripe.error}</p>}
            </div>
          </div>
          <p className="text-xs text-text-muted">
            {a.state.replace('_', ' ')} · charges {a.chargesEnabled ? 'enabled' : 'not enabled'} · artist switch {a.tipsEnabled ? 'on' : 'off'} · fee {a.feeBasisPoints / 100}%
            {a.approvedAt && ` · approved ${new Date(a.approvedAt).toLocaleDateString()}`}
          </p>
          {!a.connectedByCurrentOwner && (
            <p className="text-xs text-red-400">Connected by someone who no longer owns this profile. Don't approve.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {!a.approvedAt ? (
              <>
                <button
                  type="button"
                  disabled={busy === a.artistId || approveBlockers(a).length > 0}
                  onClick={() => act(a, 'approve')}
                  className="px-3 py-1.5 rounded-lg bg-accent-primary text-white text-xs disabled:opacity-50"
                >
                  Approve tips
                </button>
                {approveBlockers(a).length > 0 && (
                  <span className="text-xs text-text-muted">Can't approve yet: {approveBlockers(a).join('; ')}.</span>
                )}
              </>
            ) : (
              <button type="button" disabled={busy === a.artistId} onClick={() => act(a, 'revoke')} className="px-3 py-1.5 rounded-lg border border-border text-xs">
                Switch tips off
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

/** Why Approve is disabled for an account, in words — empty when it can be approved. */
function approveBlockers(a: Pick<PendingAccount, 'claimVerified' | 'chargesEnabled' | 'connectedByCurrentOwner'>): string[] {
  const reasons: string[] = [];
  if (!a.connectedByCurrentOwner) reasons.push('connected by a previous owner of this profile');
  if (!a.claimVerified) reasons.push("the profile claim isn't verified");
  if (!a.chargesEnabled) reasons.push("Stripe hasn't enabled charges yet");
  return reasons;
}
