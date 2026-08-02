import { lazy, type ComponentType } from 'react'
import { isStaleBuildAssetError } from '../services/sentry'

/**
 * `lazy()`, plus a one-shot reload when the page chunk belongs to a build that
 * no longer exists.
 *
 * Every route in main.tsx is lazy-loaded, so its chunk filename carries a
 * content hash. A tab left open across a deploy asks for a hash the new deploy
 * doesn't have, Netlify's SPA catch-all answers `200 text/html` instead of 404,
 * and the import rejects — which the error boundary shows as "Unstream hit an
 * unexpected error". Reloading fetches the new index.html and the new chunk
 * names, so we do it for the user instead of asking them to.
 *
 * The reload happens at most once per tab. A chunk that is genuinely broken
 * (rather than merely old) would otherwise reload forever, so the second
 * failure is rethrown and the error boundary takes over as before.
 */

const RELOAD_FLAG = 'unstream:stale-build-reload'

export function lazyWithRetry(importPage: () => Promise<{ default: ComponentType }>) {
  return lazy(() => importPageOrReload(importPage))
}

/** Exported for tests; use `lazyWithRetry` in app code. */
export async function importPageOrReload<T>(importPage: () => Promise<T>): Promise<T> {
  try {
    const page = await importPage()
    // The build this tab is running can serve its own chunks, so any earlier
    // reload is spent — let a future deploy get its own attempt.
    clearReloadFlag()
    return page
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!isStaleBuildAssetError(message) || hasReloaded()) {
      throw error
    }
    if (!markReloaded()) {
      // Nowhere to record the attempt means no way to stop at one reload.
      throw error
    }

    window.location.reload()
    // Never settles: the tab is on its way out, and resolving or rejecting here
    // would flash a page (or the error screen) in the moment before it goes.
    return new Promise<T>(() => {})
  }
}

function hasReloaded(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_FLAG) === '1'
  } catch {
    // Storage can be unavailable (Safari private browsing). With nowhere to
    // record the attempt we can't promise to reload only once, so don't reload.
    return true
  }
}

function markReloaded(): boolean {
  try {
    sessionStorage.setItem(RELOAD_FLAG, '1')
    return true
  } catch {
    // Same reasoning as above: an unrecorded reload is a reload loop.
    return false
  }
}

function clearReloadFlag(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG)
  } catch {
    // Storage unavailable means nothing was ever recorded.
  }
}
