import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Sentry from '@sentry/react';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { TipForm } from '../components/TipForm';
import { getTipPage, TipsApiError, type TipPageData } from '../services/tips';

// The page renders BEFORE the API answers: the form itself (amount presets from the bundled
// constants, the cover-the-fees checkbox, the FAQ note) is static copy and mounts immediately, and
// only the server-owned facts — the real artist name, the fee, open goals, eligibility — hydrate
// into it. A fan sees the whole page shape at render, not a loading screen; the pay button stays
// disabled until hydration lands (~ms after the cached GET returns), since a fee the page guessed
// at would be a lie.

/** "kid-lightbulbs" → "Kid Lightbulbs" — placeholder name until the real one hydrates. */
function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function pendingPageData(slug: string): TipPageData {
  return {
    artist: { id: '', slug, name: humanizeSlug(slug), imageUrl: null },
    takingTips: true,
  };
}

// /tip/{slug}: a one-off tip through hosted Stripe Checkout on the artist's own account
// (docs/specs/artist-patronage-spec.md §3.1, §5). On the web the Tip button opens the same form in a
// window over the page (TipSheet); this page is the address for everything that can't — the Mac app
// and extension open it in the browser, it's what a shared link points at, and Stripe's cancel link
// comes back here.

export function TipPage() {
  const { t } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<TipPageData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Static page shape: valid before the GET answers, replaced wholesale on hydration.
  const pendingData = useMemo(() => pendingPageData(slug ?? ''), [slug]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    getTipPage(slug)
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => {
        if (cancelled) return;
        const notFound = err instanceof TipsApiError && err.status === 404;
        if (!notFound) Sentry.captureException(err, { extra: { context: 'TipPage.load', slug } });
        setLoadError(notFound ? t('artist:tipPage.loadNotFound') : t('artist:tipPage.loadFailed'));
      });
    return () => { cancelled = true; };
  }, [slug, t]);

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
          ) : (
            <>
              <div className="text-center space-y-2">
                {data?.artist.imageUrl && (
                  <img src={data.artist.imageUrl} alt="" className="w-20 h-20 rounded-full object-cover mx-auto" />
                )}
                <h1 className="text-2xl font-bold">Tip {(data ?? pendingData)?.artist.name}</h1>
                <p className="text-sm text-text-muted">
                  {t('artist:tipPage.straightTo', { name: (data ?? pendingData)?.artist.name })}
                </p>
              </div>

              {data && !data.takingTips ? (
                <div className="p-4 rounded-xl border border-border space-y-3">
                  <p className="text-sm">{t('artist:tipPage.notTaking', { name: data.artist.name })}</p>
                  <Link to={`/a/${data.artist.slug}`} className="text-sm text-link hover:underline">
                    {t('artist:tipPage.seeWhereElse')}
                  </Link>
                </div>
              ) : (
                <div className="p-4 rounded-xl border border-border">
                  <TipForm
                    data={data ?? pendingData}
                    hydrated={!!data}
                    initialGoalId={searchParams.get('goal') ?? ''}
                  />
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
