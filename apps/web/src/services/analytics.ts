/**
 * Analytics tracking using GoatCounter + Unstream artist analytics API.
 *
 * General events (search, download, etc.) go to GoatCounter only.
 * Artist-specific events (search appearances, page views, link clicks)
 * go to BOTH GoatCounter and our Supabase-backed analytics API so
 * verified artists can see their stats on the dashboard.
 */

declare global {
  interface Window {
    goatcounter?: {
      count: (vars: { path: string; event: boolean }) => void;
    };
  }
}

function trackEvent(path: string): void {
  if (window.goatcounter?.count) {
    window.goatcounter.count({ path, event: true });
  }
}

/** Fire-and-forget POST to our analytics API for artist-level metrics. */
function trackArtistEvent(slug: string, metric: string): void {
  fetch('/api/analytics/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, metric }),
  }).catch(() => {}); // silently ignore errors
}

export const analytics = {
  // General events (GoatCounter only)
  trackDownload: () => trackEvent('/download'),
  trackSearch: () => trackEvent('/search'),
  trackPlatformClick: (platformName: string) => trackEvent(`/go/${platformName.toLowerCase()}`),
  trackReportIssue: () => trackEvent('/report-issue'),

  // Artist-specific events (GoatCounter + Supabase analytics API)
  trackArtistPageView: (slug: string) => {
    trackEvent(`/artist/${slug}/view`);
    trackArtistEvent(slug, 'view');
  },
  trackArtistSearchAppearance: (slug: string) => {
    trackEvent(`/artist/${slug}/search`);
    trackArtistEvent(slug, 'search');
  },
  trackArtistLinkClick: (slug: string, platform: string) => {
    trackEvent(`/artist/${slug}/click/${platform.toLowerCase()}`);
    trackArtistEvent(slug, `click:${platform.toLowerCase()}`);
  },
};
