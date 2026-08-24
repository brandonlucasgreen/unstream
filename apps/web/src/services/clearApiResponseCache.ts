/**
 * Delete the `api-cache` Cache Storage bucket the old service worker left behind.
 *
 * Until the runtimeCaching rule was removed from vite.config.ts, every /api/ GET that
 * came back 200 was written into a bucket named `api-cache` — including
 * /api/admin/verify, whose body carries claimant email addresses and their free-text
 * messages, plus /api/me/settings, /api/me/collection and /api/analytics/dashboard.
 * The bucket is keyed on URL alone, so those bodies were readable by any later request
 * for the same URL, whatever bearer token it carried.
 *
 * Removing the rule stops new writes but clears nothing already stored, and nothing
 * else will: Workbox's `cleanupOutdatedCaches` only touches its own `-precache-`
 * buckets, and the 5-minute expiry was enforced by a plugin that ran as part of the
 * route. With the route gone, that plugin never runs again, so the entries stop
 * expiring rather than expiring sooner — left alone they would sit in Cache Storage
 * indefinitely. Hence deleting the bucket by name.
 *
 * Safe to keep calling once every install is clean: `caches.delete` on a bucket that
 * isn't there resolves false and touches nothing.
 */

const BUCKET = 'api-cache'

export function clearApiResponseCache(): void {
  if (!('caches' in window)) return

  void deleteApiCacheBucket()

  // Also on handoff. The page that installs the new worker stays controlled by the old
  // one for the rest of its load, so the old rule can still write after a startup
  // delete has run. `controllerchange` fires when the new worker claims this page
  // (skipWaiting + clientsClaim), which is the moment those writes stop.
  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    void deleteApiCacheBucket()
  })
}

/**
 * Exported so the test can await the swallowed rejection — from `clearApiResponseCache`
 * both calls are floating, and an unhandled rejection there is precisely what this
 * catch exists to prevent.
 */
export async function deleteApiCacheBucket(): Promise<void> {
  try {
    await caches.delete(BUCKET)
  } catch {
    // A browser set to block site data throws on reaching Cache Storage at all —
    // synchronously on the `caches` get, which an async function turns into a
    // rejection. It never wrote the bucket either, so this is a decline rather than a
    // failure, the same reasoning as the declined registration in
    // registerServiceWorker.ts.
  }
}
