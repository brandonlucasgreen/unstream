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
      // Both optional, and that is the whole point. `index.html` sets window.goatcounter to a
      // settings object *before* count.js loads, so the object exists from the first paint;
      // count.js is what adds `count` later, if it ever arrives.
      count?: (vars: { path: string; event: boolean }) => void;
      path?: () => string;
    };
  }
}

/**
 * Record a GoatCounter event.
 *
 * Guard `count`, not just `window.goatcounter`. Private windows and content blockers stop
 * count.js loading, which used to leave `window.goatcounter` undefined — so an optional chain on
 * the object was enough. It isn't any more: our own settings script defines the object, so a
 * blocked count.js leaves a real object with no `count` on it, and calling it throws.
 *
 * That threw inside trackSearch(), which App.tsx calls just above the try block wrapping the
 * search itself — so search never ran and the page sat on its skeletons forever, in private
 * windows only. Analytics must never be able to break the product: the try/catch is the
 * backstop for whatever the next blocker does differently.
 */
function trackEvent(path: string): void {
  try {
    window.goatcounter?.count?.({ path, event: true });
  } catch {
    // Best-effort by design. A missing pageview is not worth a broken search.
  }
}

/** Fire-and-forget POST to our analytics API for artist-level metrics. */
function trackArtistEvent(slug: string, metric: string): void {
  fetch('/api/analytics/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, metric }),
  }).catch(() => {});
}

/**
 * Search appearances arrive as a burst — one per claimed artist the moment the results render —
 * and each used to be its own POST, which cost one database transaction per card. Buffer the
 * burst and send it as a single batched request instead. The window is generous because it only
 * delays analytics, never the UI; enrichment results that land seconds later simply start a
 * second batch.
 */
let appearanceBuffer: string[] = [];
let appearanceTimer: ReturnType<typeof setTimeout> | null = null;

function flushSearchAppearances(): void {
  const slugs = [...new Set(appearanceBuffer)];
  appearanceBuffer = [];
  appearanceTimer = null;
  if (slugs.length === 0) return;
  fetch('/api/analytics/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slugs, metric: 'search' }),
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

  // Search initiated (GoatCounter only — the app_events row is written once, on completion,
  // by trackSearchResults. Firing both wrote two 'search' rows per query, which doubled the
  // admin dashboard's search counts and doubled the write cost for no information.)
  trackSearch: () => {
    trackEvent('/search');
  },

  // Search completed (product analytics — the one 'search' event per query)
  trackSearchResults: (hasResults: boolean, resultCount: number) => {
    trackAppEvent('search', { has_results: hasResults, result_count: resultCount });
  },

  // Platform click (GoatCounter + product analytics)
  trackPlatformClick: (platformName: string) => {
    trackEvent(`/go/${platformName.toLowerCase()}`);
    trackAppEvent('platform_click', { platform: platformName.toLowerCase() });
  },

  // Artist-specific events (GoatCounter + Supabase artist analytics + product analytics)
  trackArtistPageView: (slug: string) => {
    trackEvent('/artist-view');
    trackArtistEvent(slug, 'view');
    trackAppEvent('page_view', { page: 'artist' });
  },
  trackArtistSearchAppearance: (slug: string) => {
    trackEvent('/artist-search');
    appearanceBuffer.push(slug);
    if (!appearanceTimer) appearanceTimer = setTimeout(flushSearchAppearances, 1000);
  },
  // Fires everything a link click means: GoatCounter, the artist's own dashboard metric, and
  // the product 'platform_click' event. A call site with a claimed slug calls this INSTEAD OF
  // trackPlatformClick, never alongside it — calling both wrote the product event twice, which
  // double-counted clicks for claimed artists (and only claimed artists) in the admin dashboard.
  trackArtistLinkClick: (slug: string, platform: string) => {
    trackEvent(`/artist-click/${platform.toLowerCase()}`);
    trackArtistEvent(slug, `click:${platform.toLowerCase()}`);
    trackAppEvent('platform_click', { platform: platform.toLowerCase() });
  },
};