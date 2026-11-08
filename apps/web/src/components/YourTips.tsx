import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { formatUsd } from '../../../../api/shared/tips';
import { getMyTips, TipsApiError, type FanTip } from '../services/tips';
import { RATE_LIMIT_MESSAGE } from '../utils/rateLimit';

// The "Tip history" section of /settings: every tip this fan has left, newest first — signed-in
// tips, and signed-out ones they saved to their account from the thanks page. Private to the fan.
// It sat on /my-collection until 2026-11-08, when that page was split; Brandon moved it here as
// too slight for a page of its own yet (a fuller "My Patronage" page may come later).
//
// The whole section stays hidden until there's a tip to show. Tips are only open to a few artists
// for now, so for nearly everyone an empty "Tip History" would describe a feature they can't use.
//
// **It doesn't ask until it's reached.** GET /api/me/tips costs a rate-limit command plus a
// three-table join to answer "none" for nearly every account. So the fetch waits for this part of
// the page to scroll into view — on /settings, below the profile and Bandcamp sections, most visits
// never get there. Two cases ask straight away: an arrival at #tips (the /tip/thanks deep link, which can't scroll to a
// section that hasn't rendered), and a browser with no IntersectionObserver.

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
  const deepLinked = location.hash === '#tips';
  const [reached, setReached] = useState(deepLinked);

  // Attached to the zero-height marker below, which stands in for this section until there is
  // something to render. A callback ref rather than an effect on `sectionRef`, because the marker
  // mounts and unmounts as the state changes and the observer has to follow it.
  const watchMarker = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    if (typeof IntersectionObserver !== 'function') {
      setReached(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setReached(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
  }, []);

  // Seeded from the hash at mount, but a hash can also arrive without remounting this component
  // (same route, new fragment) — without this the deep link would quietly wait for a scroll.
  useEffect(() => {
    if (deepLinked) setReached(true);
  }, [deepLinked]);

  useEffect(() => {
    if (!token || !reached) return;
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
  }, [token, reached]);

  // The thanks page links to /settings#tips. The section appears only after its data loads,
  // too late for the browser's own jump to the anchor, so do it once it's there.
  const hasTips = !!tips && tips.length > 0;
  useEffect(() => {
    if (hasTips && location.hash === '#tips') sectionRef.current?.scrollIntoView();
  }, [hasTips, location.hash]);

  if (!error && !hasTips) {
    // Nothing to show. Before the read, leave the marker so the observer above can tell when this
    // part of the page is reached; once it has answered, render nothing at all.
    const answered = tips !== null;
    return answered ? null : <div ref={watchMarker} aria-hidden="true" className="h-0" />;
  }

  return (
    <section
      id="tips"
      ref={sectionRef}
      aria-labelledby="your-tips-heading"
      className="scroll-mt-24 p-6 rounded-lg bg-bg-secondary border border-border space-y-4"
    >
      <h2 id="your-tips-heading" className="text-lg font-semibold">Tip history</h2>
      {error ? (
        <p className="text-sm text-error">{error}</p>
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
