import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { TipForm } from '../components/TipForm';
import { getTipPage, TipsApiError, type TipPageData } from '../services/tips';

// /tip/{slug}: a one-off tip through hosted Stripe Checkout on the artist's own account
// (docs/specs/artist-patronage-spec.md §3.1, §5). On the web the Tip button opens the same form in a
// window over the page (TipSheet); this page is the address for everything that can't — the Mac app
// and extension open it in the browser, it's what a shared link points at, and Stripe's cancel link
// comes back here.

export function TipPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<TipPageData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    getTipPage(slug)
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => {
        if (cancelled) return;
        const notFound = err instanceof TipsApiError && err.status === 404;
        if (!notFound) Sentry.captureException(err, { extra: { context: 'TipPage.load', slug } });
        setLoadError(notFound ? "We couldn't find that artist." : "Couldn't load this page. Try again in a moment.");
      });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (data?.artist.name) document.title = `Tip ${data.artist.name} | Unstream`;
    return () => { document.title = 'Unstream - Support artists directly'; };
  }, [data?.artist.name]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 px-4 py-10">
        <div className="max-w-md mx-auto space-y-6">
          {loadError ? (
            <p className="text-center text-text-muted">{loadError}</p>
          ) : !data ? (
            <p className="text-center text-text-muted">Loading…</p>
          ) : (
            <>
              <div className="text-center space-y-2">
                {data.artist.imageUrl && (
                  <img src={data.artist.imageUrl} alt="" className="w-20 h-20 rounded-full object-cover mx-auto" />
                )}
                <h1 className="text-2xl font-bold">Tip {data.artist.name}</h1>
                <p className="text-sm text-text-muted">
                  Support for their music, paid straight to {data.artist.name}'s own Stripe account.
                </p>
              </div>

              {!data.takingTips ? (
                <div className="p-4 rounded-xl border border-border space-y-3">
                  <p className="text-sm">{data.artist.name} isn't taking tips on Unstream yet.</p>
                  <Link to={`/a/${data.artist.slug}`} className="text-sm text-accent-primary hover:underline">
                    See where else to support them →
                  </Link>
                </div>
              ) : (
                <div className="p-4 rounded-xl border border-border">
                  <TipForm data={data} initialGoalId={searchParams.get('goal') ?? ''} />
                </div>
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
