import { Suspense, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { ArtistSettingsHeader, type ArtistSettingsTab } from '../components/ArtistSettingsHeader';
import { SkeletonScreen } from '../components/Skeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';

// The frame around the artist settings tabs (/artist-edit/:slug, /tips, /releases). It stays mounted
// while the artist switches tabs, so the site header, the artist's name and the tabs don't redraw:
// only the content underneath changes, and only that area shows a skeleton while a tab loads.

export interface ArtistSettingsContext {
  setArtistName: (name: string) => void;
}

/**
 * Each tab already loads the artist's name with its own data; this hands it up to the header, which
 * keeps it across tab switches. Outside the layout (a test rendering one tab) it does nothing.
 */
export function useReportArtistName(name: string | undefined) {
  const context = useOutletContext<ArtistSettingsContext | undefined>();
  useEffect(() => {
    if (name) context?.setArtistName(name);
  }, [context, name]);
}

function activeTab(pathname: string): ArtistSettingsTab {
  if (pathname.endsWith('/tips')) return 'tips';
  if (pathname.endsWith('/releases')) return 'releases';
  return 'profile';
}

export function ArtistSettingsLayout() {
  const { slug } = useParams<{ slug: string }>();
  const { pathname } = useLocation();
  const [artistName, setArtistName] = useState<string | undefined>(undefined);
  const context = useMemo<ArtistSettingsContext>(() => ({ setArtistName }), []);

  if (!slug) return null;

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />
      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <ArtistSettingsHeader slug={slug} artistName={artistName} active={activeTab(pathname)} />
          {/* The tabs' code loads on first visit; this keeps that wait inside the content area
              instead of blanking the whole page. The minimum height stops the footer jumping up
              while a tab's content is still loading. */}
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

/** What a tab shows while its data loads — the content area only, under the persistent header. */
export function TabSkeleton({ label = 'Loading' }: { label?: string }) {
  return (
    <SkeletonScreen label={label}>
      <FormSkeleton sections={2} fields={2} />
    </SkeletonScreen>
  );
}
