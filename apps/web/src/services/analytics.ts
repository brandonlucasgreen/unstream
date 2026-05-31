/**
 * Analytics tracking using GoatCounter + Unstream artist analytics API
 * + product analytics (app_events).
 *
 * General events (search, download, etc.) go to GoatCounter only.
 * Artist-specific events (search appearances, page views, link clicks)
 * go to BOTH GoatCounter and our Supabase-backed analytics API so
 * verified artists can see their stats on the dashboard.
 * Product events (all user actions) go to the app_events endpoint for
 * the admin analytics dashboard. All product events are anonymized —
 * no user IDs, no PII, just hashed session tokens.
 */

declare global {
  interface Window {
    goatcounter?: {
      count: (vars: { path: string; event: boolean }) => void;
    };
  }
}

function trackEvent(path: string): void {
  window.goatcounter?.count({ path, event: true });
}

/** Fire-and-forget POST to our analytics API for artist-level metrics. */
function trackArtistEvent(slug: string, metric: string): void {
  fetch('/api/analytics/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, metric }),
  }).catch(() => {});
}

/** Fire-and-forget POST to the product analytics endpoint. */
function trackAppEvent(
  event_type: string,
  context: Record<string, string | number | boolean> = {},
): void {
  fetch('/api/analytics/app-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type, app: 'web', context }),
  }).catch(() => {});
}

export const analytics = {
  // Download events (GoatCounter + product analytics)
  trackDownload: () => {
    trackEvent('/download');
    trackAppEvent('download', { platform: 'macos' });
  },
  trackDownloadChrome: () => {
    trackEvent('/download-chrome');
    trackAppEvent('download', { platform: 'chrome' });
  },
  trackDownloadFirefox: () => {
    trackEvent('/download-firefox');
    trackAppEvent('download', { platform: 'firefox' });
  },
  trackDownloadIosShortcut: () => {
    trackEvent('/download-ios-shortcut');
    trackAppEvent('download', { platform: 'ios-shortcut' });
  },
  trackReportIssue: () => trackEvent('/report-issue'),

  // Search initiated (GoatCounter + product analytics)
  trackSearch: () => {
    trackEvent('/search');
    trackAppEvent('search', {});
  },

  // Search results received (product analytics only)
  trackSearchResults: (hasResults: boolean, resultCount: number) => {
    trackAppEvent('search', { has_results: hasResults, result_count: resultCount });
  },

  // Platform click (GoatCounter + product analytics)
  trackPlatformClick: (platformName: string) => {
    trackEvent(`/go/${platformName.toLowerCase()}`);
    trackAppEvent('platform_click', { platform: platformName.toLowerCase() });
  },

  // Page views (product analytics only — GoatCounter handles page views automatically)
  trackPageView: (page: string) => {
    trackAppEvent('page_view', { page });
  },

  // Artist-specific events (GoatCounter + Supabase artist analytics + product analytics)
  trackArtistPageView: (slug: string) => {
    trackEvent('/artist-view');
    trackArtistEvent(slug, 'view');
    trackAppEvent('page_view', { page: 'artist' });
  },
  trackArtistSearchAppearance: (slug: string) => {
    trackEvent('/artist-search');
    trackArtistEvent(slug, 'search');
  },
  trackArtistLinkClick: (slug: string, platform: string) => {
    trackEvent(`/artist-click/${platform.toLowerCase()}`);
    trackArtistEvent(slug, `click:${platform.toLowerCase()}`);
    trackAppEvent('platform_click', { platform: platform.toLowerCase() });
  },
};