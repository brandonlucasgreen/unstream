import * as Sentry from '@sentry/react'

/**
 * Register the PWA service worker, and treat a refusal as a refusal rather than
 * a crash.
 *
 * vite-plugin-pwa injects this for us by default, but the `registerSW.js` it
 * generates is one unguarded line:
 *
 *   navigator.serviceWorker.register('/sw.js', { scope: '/' })
 *
 * No `.catch()`, so anything that declines to register becomes an unhandled
 * promise rejection, which Sentry's global handler reports at error level. The
 * declines are all routine:
 *
 * - Google's Web Rendering Service — Googlebot and Google-Read-Aloud — replaces
 *   `register` with a stub that rejects `Error: Rejected` on purpose. Crawlers
 *   don't run service workers. This is what filled the issue: a Read-Aloud fetch
 *   of the homepage, reported as if a person had hit an error on page one.
 * - Chrome incognito and Firefox private browsing refuse registration.
 * - Enterprise policy, or a browser set to block site data, refuses it too.
 *
 * None of those are broken pages. Without a service worker the app is simply
 * online-only, which is a state it supports. So `injectRegister` is off in
 * vite.config.ts and we register from here instead, recording a failure as a
 * breadcrumb — there to explain a later error, not to be an error itself.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      Sentry.addBreadcrumb({
        category: 'pwa',
        level: 'info',
        message: 'Service worker registration declined',
        data: { reason: error instanceof Error ? error.message : String(error) },
      })
    })
  })
}
