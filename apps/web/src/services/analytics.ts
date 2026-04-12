/**
 * Analytics tracking using Umami + Unstream artist analytics API
 * + product analytics (app_events).
 *
 * General events (search, download, etc.) go to Umami only.
 * Artist-specific events (search appearances, page views, link clicks)
 * go to BOTH Umami and our Supabase-backed analytics API so
 * verified artists can see their stats on the dashboard.
 * Product events (all user actions) go to the app_events endpoint for
 * the admin analytics dashboard. All product events are anonymized —
 * no user IDs, no PII, just hashed session tokens.
 */

declare global {
  interface Window {
    umami?: {
      track: (eventName: string, data?: Record<string, string | number | boolean>) => void;
    };
  }
}

function trackEvent(eventName: string): void {
  window.umami?.track(eventName);
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
  // General events (Umami only)
  trackDownload: () => trackEvent('download'),
  trackReportIssue: () => trackEvent('report-issue'),

  // Search initiated (Umami + product analytics — fires before results arrive)
  trackSearch: () => {
    trackEvent('search');
    trackAppEvent('search', {});
  },

  // Search results received (product analytics — fires once results are known)
  trackSearchResults: (hasResults: boolean, resultCount: number) => {
    trackAppEvent('search', { has_results: hasResults, result_count: resultCount });
  },

  // Platform click (Umami + product analytics)
  trackPlatformClick: (platformName: string) => {
    trackEvent(`go-${platformName.toLowerCase()}`);
    trackAppEvent('platform_click', { platform: platformName.toLowerCase() });
  },

  // Page views (product analytics only — Umami handles page views automatically)
  trackPageView: (page: string) => {
    trackAppEvent('page_view', { page });
  },

  // Artist-specific events (Umami + Supabase artist analytics + product analytics)
  trackArtistPageView: (slug: string) => {
    trackEvent(`artist-view`);
    trackArtistEvent(slug, 'view');
    trackAppEvent('page_view', { page: 'artist' });
  },
  trackArtistSearchAppearance: (slug: string) => {
    trackEvent(`artist-search`);
    trackArtistEvent(slug, 'search');
  },
  trackArtistLinkClick: (slug: string, platform: string) => {
    trackEvent(`artist-click-${platform.toLowerCase()}`);
    trackArtistEvent(slug, `click:${platform.toLowerCase()}`);
    trackAppEvent('platform_click', { platform: platform.toLowerCase() });
  },
};
