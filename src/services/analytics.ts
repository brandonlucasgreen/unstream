/**
 * Analytics tracking using GoatCounter
 * https://www.goatcounter.com/help/events
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
};
