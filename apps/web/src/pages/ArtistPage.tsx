import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { LoadingProfile } from '../components/LoadingProfile';
import { NotFoundCard } from '../components/NotFoundCard';
import { RichArtistProfile } from '../components/RichArtistProfile';
import { UnclaimedQuietCard } from '../components/UnclaimedQuietCard';
import { LoginInterstitial } from '../components/LoginInterstitial';
import { AdminCatalogButton } from '../components/AdminCatalogButton';
import { analytics } from '../services/analytics';
import { useAuth } from '../contexts/AuthContext';
import type { ArtistPagePayload } from '../types/artist-page';

export function ArtistPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const justClaimed = searchParams.get('claimed') !== null;

  const [payload, setPayload] = useState<ArtistPagePayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showLoginInterstitial, setShowLoginInterstitial] = useState(false);

  const { session, isArtistSaved, saveArtist, removeSavedArtist, loadSavedArtists } = useAuth();

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    loadSavedArtists(controller.signal);
    return () => controller.abort();
  }, [session]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setIsLoading(true);
    setNotFound(false);
    setPayload(null);
    fetch(`/api/artist-page?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: ArtistPagePayload | null) => {
        if (cancelled) return;
        if (data === null) setNotFound(true);
        else setPayload(data);
      })
      .catch(err => {
        if (cancelled) return;
        Sentry.captureException(err, { extra: { context: 'ArtistPage.fetchArtistPage', slug } });
        setNotFound(true);
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (slug) analytics.trackArtistPageView(slug);
  }, [slug]);

  useEffect(() => {
    if (payload?.artist.name) {
      document.title = `${payload.artist.name} on Bandcamp & alternative platforms | Unstream`;
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        const desc = payload.profile?.bio
          ? `${payload.artist.name} on Unstream — ${payload.profile.bio.slice(0, 160)}`
          : `${payload.artist.name} is on Bandcamp and other alternative platforms. Find direct links and support them outside streaming.`;
        metaDesc.setAttribute('content', desc);
      }
    }
    return () => { document.title = 'Unstream - Support artists directly'; };
  }, [payload?.artist.name, payload?.profile?.bio]);

  // Auth-aware save wiring
  const artistId = payload?.artist.id ?? null;
  const artistName = payload?.artist.name ?? '';
  const artistImageUrl = payload?.artist.imageUrl ?? '';
  const isSaved = artistId ? isArtistSaved(artistId) : false;

  const handleSave = async () => {
    if (!artistId) return;
    if (isSaved) {
      await removeSavedArtist(artistId);
    } else {
      if (!session) {
        setShowLoginInterstitial(true);
        return;
      }
      await saveArtist(artistId, undefined, artistName, artistImageUrl ?? undefined);
    }
  };

  const handleUnsave = async () => {
    if (artistId) await removeSavedArtist(artistId);
  };

  return (
    <div className="min-h-screen">
      <Header />
      <main className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          {isLoading ? (
            <LoadingProfile />
          ) : notFound || !payload ? (
            <NotFoundCard slug={slug} />
          ) : payload.profile?.verifiedAt ? (
            <RichArtistProfile
              payload={payload}
              slug={slug!}
              justClaimed={justClaimed}
              onSave={handleSave}
              onUnsave={handleUnsave}
              isSaved={isSaved}
              disabledSave={!artistId}
            />
          ) : (
            <UnclaimedQuietCard
              payload={payload}
              slug={slug!}
              justClaimed={justClaimed}
              onSave={handleSave}
              onUnsave={handleUnsave}
              isSaved={isSaved}
              disabledSave={!artistId}
            />
          )}
          {/* Renders nothing unless a signed-in admin is looking. */}
          {artistId && <AdminCatalogButton artistId={artistId} />}
        </div>
      </main>
      <Footer />
      {showLoginInterstitial && artistId && (
        <LoginInterstitial
          artistId={artistId}
          artistName={artistName}
          onClose={() => setShowLoginInterstitial(false)}
        />
      )}
    </div>
  );
}