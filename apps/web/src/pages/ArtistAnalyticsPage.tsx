import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ArtistAnalytics } from '../components/ArtistAnalytics';
import { useReportArtistName } from './ArtistSettingsLayout';

// /analytics/:slug — an artist's numbers and recent activity, inside ArtistSettingsLayout. Split
// out of the /my-artists card on 2026-11-08, where it was three tiles; a verified artist with one
// artist lands here when they sign in (services/accountHome.ts).

export function ArtistAnalyticsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [artistName, setArtistName] = useState<string | undefined>(undefined);
  useReportArtistName(artistName);

  useEffect(() => {
    if (authLoading || session || !slug) return;
    navigate(`/login?next=${encodeURIComponent(`/analytics/${encodeURIComponent(slug)}`)}`, { replace: true });
  }, [authLoading, session, slug, navigate]);

  if (!slug || !session) return null;
  return <ArtistAnalytics slug={slug} onLoaded={data => setArtistName(data.artistName)} />;
}
