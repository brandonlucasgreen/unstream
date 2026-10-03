import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { ArtistSettingsHeader } from '../components/ArtistSettingsHeader';
import { ArtistTipsPanel } from '../components/ArtistTipsPanel';
import { PageSkeleton } from '../components/PageSkeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';
import { getTipSettings, type TipSettings } from '../services/tips';

// /artist-edit/:slug/tips — the Manage Tips tab of the artist settings area. Stripe onboarding
// returns here (tips-connect.ts sets the return URL), and loading the settings is what syncs the
// account's state on the way back.

export function ArtistTipsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [settings, setSettings] = useState<TipSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />
      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <ArtistSettingsHeader slug={slug} artistName={settings?.artistName} active="tips" />
          {loadError ? (
            <p className="text-sm text-red-400">{loadError}</p>
          ) : !settings || !session ? (
            <PageSkeleton label="Loading tips">
              <FormSkeleton sections={2} fields={2} />
            </PageSkeleton>
          ) : !settings.available ? (
            <p className="text-sm text-text-muted">Tips aren't available on Unstream yet.</p>
          ) : (
            <ArtistTipsPanel slug={slug} token={session.access_token} settings={settings} onChange={setSettings} />
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
