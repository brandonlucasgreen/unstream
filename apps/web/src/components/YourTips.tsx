import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { formatUsd } from '../../../../api/shared/tips';
import { getMyTips, TipsApiError, type FanTip } from '../services/tips';
import { RATE_LIMIT_MESSAGE } from '../utils/rateLimit';

// The "Tip History" section of /my-collection: every tip this fan has left, newest first —
// signed-in tips, and signed-out ones they saved to their account from the thanks page. Private
// to the fan. It sits with the collection and saved artists rather than in /settings, because a
// record of what you've paid artists is something you have, not something you configure.
//
// The whole section stays hidden until there's a tip to show. Tips are only open to a few artists
// for now, so for nearly everyone an empty "Tip History" would describe a feature they can't use.

const STATUS_LABEL: Partial<Record<FanTip['status'], string>> = {
  refunded: 'Refunded',
  disputed: 'Disputed',
};

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function YourTips() {
  const { session } = useAuth();
  const location = useLocation();
  const sectionRef = useRef<HTMLElement>(null);
  const [tips, setTips] = useState<FanTip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = session?.access_token ?? null;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    getMyTips(token)
      .then(t => { if (!cancelled) setTips(t); })
      .catch(err => {
        if (cancelled) return;
        if (err instanceof TipsApiError && err.status === 429) {
          setError(RATE_LIMIT_MESSAGE);
          return;
        }
        Sentry.captureException(err, { extra: { context: 'YourTips.load' } });
        setError("Couldn't load your tips. Try again in a moment.");
      });
    return () => { cancelled = true; };
  }, [token]);

  // The thanks page links to /my-collection#tips. The section appears only after its data loads,
  // too late for the browser's own jump to the anchor, so do it once it's there.
  const hasTips = !!tips && tips.length > 0;
  useEffect(() => {
    if (hasTips && location.hash === '#tips') sectionRef.current?.scrollIntoView();
  }, [hasTips, location.hash]);

  if (!error && !hasTips) return null;

  return (
    <section
      id="tips"
      ref={sectionRef}
      aria-labelledby="your-tips-heading"
      className="scroll-mt-24 space-y-4"
    >
      <h2 id="your-tips-heading" className="text-lg font-semibold flex items-center gap-2">
        <svg className="w-5 h-5 text-accent-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Tip History
      </h2>
      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            Only you can see this. Each tip went straight to the artist's own Stripe account, and your receipt
            came from them. For a refund, contact the artist using the details on that receipt.
          </p>
          <ul className="divide-y divide-border">
            {tips!.map(tip => (
              <li key={tip.id} className="py-3 flex items-start justify-between gap-4 text-sm">
                <div className="min-w-0 space-y-0.5">
                  {tip.artistSlug ? (
                    <Link to={`/a/${tip.artistSlug}`} className="font-medium hover:underline">{tip.artistName}</Link>
                  ) : (
                    <span className="font-medium">{tip.artistName}</span>
                  )}
                  <p className="text-text-muted">
                    {dateFormat.format(new Date(tip.createdAt))}
                    {tip.goalTitle && <> · towards “{tip.goalTitle}”</>}
                  </p>
                </div>
                <div className="shrink-0 text-right space-y-0.5">
                  <p className={tip.status === 'refunded' ? 'font-medium line-through text-text-muted' : 'font-medium'}>
                    {formatUsd(tip.amountCents)}
                  </p>
                  {STATUS_LABEL[tip.status] ? (
                    <p className="text-text-muted">{STATUS_LABEL[tip.status]}</p>
                  ) : tip.refundedCents > 0 ? (
                    <p className="text-text-muted">{formatUsd(tip.refundedCents)} refunded</p>
                  ) : tip.paidCents > tip.amountCents ? (
                    <p className="text-text-muted">you paid {formatUsd(tip.paidCents)}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
