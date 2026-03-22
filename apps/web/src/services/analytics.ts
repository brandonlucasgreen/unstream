/**
 * Analytics tracking using GoatCounter
 * https://www.goatcounter.com/help/events
 *
 * Artist-specific events use a /artist/{slug}/ prefix so they can be
 * queried per-artist from the GoatCounter API.
 */

declare global {
  interface Window {
    goatcounter?: {
      count: (vars: { path: string; event: boolean }) => void;
    };
  }
}

export function trackEvent(path: string): void {
  if (window.goatcounter?.count) {
    window.goatcounter.count({
      path: path,
      event: true,
    });
  }
}

export const analytics = {
  trackDownload: () => trackEvent('/download'),
  trackSearch: () => trackEvent('/search'),
  trackPlatformClick: (platformName: string) => trackEvent(`/go/${platformName.toLowerCase()}`),
  trackReportIssue: () => trackEvent('/report-issue'),

  // Artist-specific events (attributed to a slug)
  trackArtistPageView: (slug: string) => trackEvent(`/artist/${slug}/view`),
  trackArtistSearchAppearance: (slug: string) => trackEvent(`/artist/${slug}/search`),
  trackArtistLinkClick: (slug: string, platform: string) =>
    trackEvent(`/artist/${slug}/click/${platform.toLowerCase()}`),
};
