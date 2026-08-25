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

  // Held until load so registration never competes with the first paint, which
  // is what the injected script did too. Checking readyState rather than
  // trusting the listener: main.tsx runs as a deferred module, so today it is
  // reliably before 'load' — but a listener added after 'load' has fired never
  // runs, and that failure is silent, a service worker that simply never exists.
  if (document.readyState === 'complete') {
    register()
  } else {
    window.addEventListener('load', register, { once: true })
  }
}

function register(): void {
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(watchForUpdates)
    .catch((error: unknown) => {
      Sentry.addBreadcrumb({
        category: 'pwa',
        level: 'info',
        message: 'Service worker registration declined',
        data: { reason: error instanceof Error ? error.message : String(error) },
      })
    })
}

/**
 * Never re-check more often than this. A tab flipped between repeatedly shouldn't ask on every
 * flip; half an hour is far quicker than deploys land and costs a conditional request that the
 * ETag answers with a 304.
 */
const MIN_CHECK_INTERVAL_MS = 30 * 60 * 1000

/**
 * Re-check `/sw.js` whenever the tab comes back to the foreground.
 *
 * `register()` above already triggers one check per page load — but this is a single-page app,
 * so moving between routes is not a navigation and never triggers another. A tab left open for
 * days therefore asks exactly once, on the load that opened it, and then keeps serving whatever
 * that worker precached no matter how many deploys go out. When the precached build's chunks
 * are eventually deleted from the CDN, its routes render deleted code or fail to open at all.
 *
 * Coming back to a tab is the moment worth spending a request on: it is when someone is about
 * to use the page, and it is exactly the long-idle case that a per-load check cannot reach.
 * It also means the refresh offered by StaleBuildBanner can deliver a new build — a reload with
 * a stale worker is served the same precached shell, so the banner would otherwise reappear
 * forever having changed nothing.
 *
 * Registration has just performed its own check, so the clock starts now rather than at zero.
 */
function watchForUpdates(registration: ServiceWorkerRegistration): void {
  let lastCheck = Date.now()

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastCheck < MIN_CHECK_INTERVAL_MS) return
    lastCheck = Date.now()
    void checkForUpdate(registration)
  })
}

/**
 * Ask the browser to re-fetch `/sw.js` and install a new worker if one is there.
 *
 * Exported so the test can await the swallowed rejection — at the call site above the promise
 * is floating, and an unhandled rejection is precisely what this catch exists to prevent:
 * Sentry's global handler reports one at error level, which is how the declined-registration
 * bug in the docstring above reached the issue tracker in the first place.
 */
export async function checkForUpdate(registration: ServiceWorkerRegistration): Promise<void> {
  try {
    await registration.update()
  } catch {
    // Offline, or a browser that refuses the check. Nothing to do and nothing worth
    // reporting — the next time they focus the tab, we ask again.
  }
}
