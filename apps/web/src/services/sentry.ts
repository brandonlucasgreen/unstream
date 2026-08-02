/**
 * Sentry configuration and initialization
 * 
 * DSN should be set via environment variable: VITE_SENTRY_DSN
 * Environment should be set via: VITE_SENTRY_ENV
 * App version should be set via: VITE_APP_VERSION
 */

import * as Sentry from '@sentry/react'

export { Sentry }

/**
 * True when an error is a page asking for a JS chunk its deploy no longer has.
 *
 * This is what a deploy does to an already-open tab. Pages are lazy-loaded
 * (`lazy(() => import('./pages/LoginPage.tsx'))` and friends in main.tsx), so the
 * chunk filename carries a content hash. A tab still running build N clicks a link,
 * requests `/assets/LoginPage-<oldHash>.js`, and build N+1 doesn't have that file.
 * Netlify's SPA catch-all then answers `200 text/html` instead of 404, so the
 * browser rejects it as a module and the import promise rejects — which React
 * surfaces through the error boundary as "Unstream hit an unexpected error".
 *
 * Each engine words it differently, hence the list.
 */
export function isStaleBuildAssetError(message: string): boolean {
  return (
    // Chrome / Edge
    message.includes('Failed to fetch dynamically imported module') ||
    // Firefox
    message.includes('error loading dynamically imported module') ||
    // Safari
    message.includes('Importing a module script failed') ||
    // Any engine, when the SPA catch-all serves index.html in place of the chunk
    message.includes('Expected a JavaScript module script') ||
    // Vite's preload helper, when a stylesheet for a route chunk is missing
    message.includes('Unable to preload CSS for')
  )
}

/**
 * True when an error came from a WebKit-to-native bridge script that something
 * outside our page injected into it.
 *
 * Sentry attributes these to us because the stack points at
 * `https://unstream.stream/:1` — but our document has no inline JavaScript
 * (`apps/web/index.html` loads the bundle and GoatCounter as external files, and
 * the og-metadata edge function adds no scripts), so line 1 of the document is
 * never our code. It's an in-app browser: iOS apps that open links in a WKWebView
 * inject their own script, which reports home over `window.webkit.messageHandlers`
 * and throws when that bridge isn't there — usually from a `pagehide` listener
 * firing after the webview has already torn it down. The frame names in those
 * traces (`sendDataToNative`, `sendPageHideMessage`) exist nowhere in this repo.
 *
 * Nothing we ship causes it and nothing we ship can fix it, so it's noise. If
 * Unstream ever loads itself in a WKWebView of its own (the Apple app is native
 * SwiftUI today, with no webview anywhere), delete this filter — at that point it
 * would be hiding a real bug.
 */
export function isInjectedNativeBridgeError(message: string): boolean {
  return message.includes('webkit.messageHandlers')
}

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  const environment = import.meta.env.VITE_SENTRY_ENV || import.meta.env.MODE
  const version = import.meta.env.VITE_APP_VERSION || 'unknown'

  // Don't initialize Sentry if DSN is not set (e.g., local dev)
  if (!dsn) {
    console.warn('Sentry DSN not configured. Error reporting disabled.')
    return
  }

  // Validate DSN format
  if (!dsn.startsWith('https://')) {
    console.warn('Sentry DSN format invalid. Expected to start with https://')
  }

  Sentry.init({
    dsn,
    environment,
    release: version,

    // Basic React Router integration for context
    integrations: [],

    // Sample rate for error events (100% - capture all errors)
    tracesSampleRate: 0.0, // No performance monitoring by default
    profilesSampleRate: 0.0,

    // Don't send request data, cookies, or headers by default
    sendDefaultPii: false,

    // Filter out known non-critical errors
    beforeSend(event, hint) {
      // Don't send errors in development (let console handles it)
      if (import.meta.env.DEV) {
        return null
      }

      // Errors caught by the global handler sometimes arrive with no
      // originalException — an injected script's TypeError is one of them — and the
      // message only survives on the event. Read both, so a filter below can't miss
      // an error purely because of how it happened to be captured.
      const errorMessage = [
        hint?.originalException?.toString() || '',
        event.exception?.values?.[0]?.value || '',
      ].join(' ')

      // Classified BEFORE the benign-error filter so a stale-build failure can
      // never be mistaken for a transient network blip and dropped.
      if (isStaleBuildAssetError(errorMessage)) {
        event.tags = {
          ...event.tags,
          error_type: 'stale-build-asset',
          // Which route the user was trying to reach — the reason this shows up
          // as a login bug is that /login is one of the lazy-loaded routes.
          route: window.location.pathname,
        }
        event.extra = {
          ...event.extra,
          runningRelease: version,
          hasServiceWorker: !!navigator.serviceWorker?.controller,
        }
        // One issue for all of them, titled for what it actually is. Left to
        // group itself, every browser's wording becomes a separate issue and
        // none of the titles mention a deploy.
        event.fingerprint = ['stale-build-asset']
        return event
      }

      // Somebody else's script failing inside our page. Not our bug to fix.
      if (isInjectedNativeBridgeError(errorMessage)) {
        return null
      }

      // Filter out common benign errors
      if (errorMessage.includes('Network Error') || errorMessage.includes('AbortError')) {
        return null
      }

      return event
    },
  })

  console.log('Sentry initialized (env: ' + environment + ')')
}

/**
 * Capture a test error for verification
 * Only works in development to avoid sending test errors to Sentry
 */
export function captureTestError(): void {
  if (!import.meta.env.DEV) {
    return
  }

  try {
    throw new Error(`[Sentry Test] This is a test error from ${import.meta.env.VITE_SENTRY_ENV || import.meta.env.MODE}. If you see this in Sentry, the setup worked!`)
  } catch (error) {
    Sentry.captureException(error)
  }
}
