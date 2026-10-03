import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { ArtistTipsPanel } from '../components/ArtistTipsPanel';
import { TabSkeleton, useReportArtistName } from './ArtistSettingsLayout';
import { getTipSettings, type TipSettings } from '../services/tips';

// /artist-edit/:slug/tips — the Manage Tips tab, rendered inside ArtistSettingsLayout. Stripe onboarding
// returns here (tips-connect.ts sets the return URL), and loading the settings is what syncs the
// account's state on the way back.

export function ArtistTipsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [settings, setSettings] = useState<TipSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useReportArtistName(settings?.artistName);

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      navigate('/artist-login', { replace: true });
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

  if (!slug) return null;

  if (loadError) return <p className="text-sm text-red-400">{loadError}</p>;
  if (!settings || !session) return <TabSkeleton label="Loading tips" />;
  if (!settings.available) return <p className="text-sm text-text-muted">Tips aren't available on Unstream yet.</p>;
  return <ArtistTipsPanel slug={slug} token={session.access_token} settings={settings} onChange={setSettings} />;
}
