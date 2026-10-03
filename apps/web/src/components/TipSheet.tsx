import { useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';
import { TipForm } from './TipForm';
import { getTipPage, type TipPageData } from '../services/tips';

// The tip window: the /tip/{slug} form opened over search results or the artist page, so a fan tips
// without leaving where they are until Stripe's own payment page. A native <dialog> shown modally,
// which gives focus handling, Escape to close and an inert page behind it. Centred on wider screens,
// a sheet from the bottom on phones. `m-auto` is load-bearing: Tailwind's reset zeroes the margin the
// browser centres a <dialog> with, which pins it to the top-left corner.

export function TipSheet({ slug, artistName, goalId, onClose }: {
  slug: string;
  artistName: string;
  goalId?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<TipPageData | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    getTipPage(slug)
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => {
        if (cancelled) return;
        Sentry.captureException(err, { extra: { context: 'TipSheet.load', slug } });
        setLoadError(true);
      });
    return () => { cancelled = true; };
  }, [slug]);

  const close = () => dialogRef.current?.close();

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="tip-sheet-title"
      onClose={onClose}
      // Clicks inside stay inside: the Tip button can sit within other clickable UI. A click on the
      // dialog element itself is a click on the dimmed backdrop, which closes it.
      onClick={e => {
        e.stopPropagation();
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={e => e.stopPropagation()}
      className="m-auto w-full max-w-md max-h-[90vh] overflow-y-auto p-0 rounded-2xl border border-border bg-bg-primary text-text-primary shadow-xl backdrop:bg-black/60 max-sm:max-w-none max-sm:mb-0 max-sm:rounded-b-none"
    >
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
    </dialog>
  );
}
