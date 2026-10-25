import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/react';
import { TipForm } from './TipForm';
import { Dialog } from './Dialog';
import { getTipPageCached, type TipPageData } from '../services/tips';

// The tip window: the /tip/{slug} form opened over search results or the artist page, so a fan tips
// without leaving where they are until Stripe's own payment page. Built on Dialog (a native <dialog>
// shown modally — focus handling, Escape, an inert page behind), which grew out of this component.
// Centred on wider screens, a sheet from the bottom on phones.

export function TipSheet({ slug, artistName, goalId, onClose }: {
  slug: string;
  artistName: string;
  goalId?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<TipPageData | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTipPageCached(slug)
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => {
        if (cancelled) return;
        Sentry.captureException(err, { extra: { context: 'TipSheet.load', slug } });
        setLoadError(true);
      });
    return () => { cancelled = true; };
  }, [slug]);

  return (
    <Dialog labelledBy="tip-sheet-title" onClose={onClose}>
      {close => (
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="tip-sheet-title" className="text-xl font-bold">Tip {artistName}</h2>
            <p className="text-sm text-text-muted">
              Support for their music, paid straight to {artistName}'s own Stripe account.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="shrink-0 w-11 h-11 -mt-2 -mr-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {loadError ? (
          <p className="text-sm text-text-muted">Couldn't load this right now. Try again in a moment.</p>
        ) : !data ? (
          <p className="text-sm text-text-muted" role="status">Loading…</p>
        ) : !data.takingTips ? (
          <p className="text-sm">{artistName} isn't taking tips on Unstream right now.</p>
        ) : (
          <TipForm data={data} initialGoalId={goalId} />
        )}
      </div>
      )}
    </Dialog>
  );
}
