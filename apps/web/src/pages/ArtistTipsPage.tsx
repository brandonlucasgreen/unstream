import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { ArtistTipsPanel } from '../components/ArtistTipsPanel';
import { TabSkeleton, useReportArtistName } from './ArtistSettingsLayout';
import { connectStripe, getTipSettings, TipsApiError, type TipSettings } from '../services/tips';
import { useResetOnPageShow } from '../hooks/useResetOnPageShow';

// /artist-edit/:slug/tips — the Manage Tips tab, rendered inside ArtistSettingsLayout. Stripe onboarding
// returns here (tips-connect.ts sets the return URL), and loading the settings is what syncs the
// account's state on the way back.
//
// Stripe adds `?stripe=return` when the artist finishes or leaves onboarding, and `?stripe=refresh`
// when the onboarding link it was given has expired. A refresh mid-onboarding fetches a fresh link and
// goes straight back, so the artist doesn't land here wondering what to press. The parameter is
// removed from the address as soon as it's read, so Back or a reload can't trigger that again.

export function ArtistTipsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { session, isLoading: authLoading } = useAuth();
  const [settings, setSettings] = useState<TipSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Read once: the address loses the parameter straight after.
  const [stripeParam] = useState(() => searchParams.get('stripe'));
  const refreshStarted = useRef(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Back from Stripe after the automatic redirect restores this page from the back/forward cache,
  // still saying "Taking you back to Stripe…"; show the panel instead.
  const [restored, setRestored] = useState(false);
  useResetOnPageShow(() => setRestored(true));
  useReportArtistName(settings?.artistName);

  useEffect(() => {
    if (!searchParams.has('stripe')) return;
    const rest = new URLSearchParams(searchParams);
    rest.delete('stripe');
    setSearchParams(rest, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      if (slug) navigate(`/login?next=${encodeURIComponent(`/artist-edit/${encodeURIComponent(slug)}/tips`)}`, { replace: true });
      return;
    }
    if (!slug) return;
    let cancelled = false;
    getTipSettings(session.access_token, slug)
      .then(s => { if (!cancelled) setSettings(s); })
      .catch(err => {
        if (cancelled) return;
        Sentry.captureException(err, { extra: { context: 'ArtistTipsPage.load', slug } });
        setLoadError(err instanceof Error ? err.message : "Couldn't load tips right now. Try refreshing.");
      });
    return () => { cancelled = true; };
  }, [authLoading, session, slug, navigate]);

  // Only an artist still mid-onboarding needs a fresh link; anyone further along just sees the panel.
  const autoRefresh = stripeParam === 'refresh' && settings?.state === 'onboarding' && !settings.foreignAccount;

  useEffect(() => {
    if (!autoRefresh || !session || !slug || refreshStarted.current) return;
    refreshStarted.current = true;
    connectStripe(session.access_token, slug, {})
      .then(url => { window.location.href = url; })
      .catch(err => {
        if (!(err instanceof TipsApiError)) Sentry.captureException(err, { extra: { context: 'ArtistTipsPage.refresh', slug } });
        const reason = err instanceof TipsApiError ? err.message : "Couldn't reach Stripe.";
        setRefreshError(`Stripe's link had expired and we couldn't get a new one. ${reason}`);
      });
  }, [autoRefresh, session, slug]);

  if (!slug) return null;

  if (loadError) return <p className="text-sm text-red-400">{loadError}</p>;
  if (!settings || !session) return <TabSkeleton label="Loading tips" />;
  if (!settings.available) return <p className="text-sm text-text-muted">Tips aren't available on Unstream yet.</p>;
  if (autoRefresh && !refreshError && !restored) {
    return <p className="text-sm text-text-secondary" role="status">Taking you back to Stripe…</p>;
  }
  return (
    <div className="space-y-4">
      {stripeParam === 'return' && (
        <p className="text-sm text-text-secondary" role="status">Back from Stripe. Here's where things stand.</p>
      )}
      {refreshError && <p className="text-sm text-red-400">{refreshError}</p>}
      <ArtistTipsPanel slug={slug} token={session.access_token} settings={settings} onChange={setSettings} />
    </div>
  );
}
