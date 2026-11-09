import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { TabSkeleton, useReportArtistName } from './ArtistSettingsLayout';
import { EmbedWidgetPanel } from '../components/EmbedWidgetPanel';
import type { ArtistPagePayload } from '../types/artist-page';

// /promote/:slug/embed — the embed widget, a tab of the Promote page (Brandon, 2026-11-09). The
// same customiser as the Embed button on the artist's public page, which was the only way in and
// not one an artist would think to look for. It reads the same public /api/artist-page the artist
// page does, so the links on offer are the ones fans see. Nothing here is private or written: the
// snippet only names public data, so this needs a signed-in artist for consistency with the other
// tabs, not for safety.

export function PromoteEmbedPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [payload, setPayload] = useState<ArtistPagePayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const userId = session?.user?.id;

  useReportArtistName(payload?.artist.name);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      if (slug) navigate(`/login?next=${encodeURIComponent(`/promote/${encodeURIComponent(slug)}/embed`)}`, { replace: true });
      return;
    }
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/artist-page?slug=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: ArtistPagePayload) => {
        if (!cancelled) setPayload(data);
      })
      .catch((err) => {
        if (cancelled) return;
        Sentry.captureException(err, { extra: { context: 'PromoteEmbedPage.load', slug } });
        setLoadError('Couldn’t load your links right now. Try refreshing.');
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading, userId, slug, navigate]);

  if (loadError) return <p className="text-sm text-error">{loadError}</p>;
  if (!payload) return <TabSkeleton label="Loading" />;

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        Put your links on your own website: pick the platforms, their order and the look, then copy
        the snippet into your site&rsquo;s HTML.
      </p>
      <EmbedWidgetPanel
        artistName={payload.artist.name}
        slug={payload.artist.slug}
        links={[...payload.links, ...payload.socialLinks]}
        showHeading={false}
      />
    </div>
  );
}
