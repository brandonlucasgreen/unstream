import { Suspense, useEffect, useMemo, useState } from 'react';
import { Navigate, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { ArtistSettingsHeader, type ArtistSettingsSection } from '../components/ArtistSettingsHeader';
import { SkeletonScreen } from '../components/Skeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';

// The frame around each page an artist manages from /my-artists: /artist-edit/:slug (Edit),
// /releases/:slug, /tips/:slug and /promote/:slug. One per page, not tabs: they were tabs under
// Edit until 2026-10-29. The page loads the artist's name with its own data and hands it up here,
// and only the content area shows a skeleton while it loads.

export interface ArtistSettingsContext {
  setArtistName: (name: string) => void;
}

/**
 * Each page already loads the artist's name with its own data; this hands it up to the header.
 * Outside the layout (a test rendering one page) it does nothing.
 */
export function useReportArtistName(name: string | undefined) {
  const context = useOutletContext<ArtistSettingsContext | undefined>();
  useEffect(() => {
    if (name) context?.setArtistName(name);
  }, [context, name]);
}

export function ArtistSettingsLayout({ section }: { section: ArtistSettingsSection }) {
  const { slug } = useParams<{ slug: string }>();
  const [artistName, setArtistName] = useState<string | undefined>(undefined);
  const context = useMemo<ArtistSettingsContext>(() => ({ setArtistName }), []);

  if (!slug) return null;

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />
      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <ArtistSettingsHeader slug={slug} artistName={artistName} section={section} />
          {/* The page's code loads on first visit; this keeps that wait inside the content area
              instead of blanking the whole page. The minimum height stops the footer jumping up
              while the content is still loading. */}
          <div className="min-h-[60vh]">
            <Suspense fallback={<TabSkeleton />}>
              <Outlet context={context} />
            </Suspense>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

/**
 * The old tab addresses, /artist-edit/:slug/releases and /tips, sent to their own pages, query
 * kept. Stripe's onboarding links and tip emails already sent point at the old tips address, and
 * `?stripe=return|refresh` has to arrive with them.
 */
export function RedirectToSection({ to }: { to: 'releases' | 'tips' | 'promote' }) {
  const { slug } = useParams<{ slug: string }>();
  const { search } = useLocation();
  if (!slug) return <Navigate to="/my-artists" replace />;
  return <Navigate to={`/${to}/${encodeURIComponent(slug)}${search}`} replace />;
}

/** What a page shows while its data loads — the content area only, under the header. */
export function TabSkeleton({ label = 'Loading' }: { label?: string }) {
  return (
    <SkeletonScreen label={label}>
      <FormSkeleton sections={2} fields={2} />
    </SkeletonScreen>
  );
}
