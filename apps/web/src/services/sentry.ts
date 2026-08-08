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
    // Safari, when the fetch itself failed
    message.includes('Importing a module script failed') ||
    // Chromium, when the SPA catch-all serves index.html in place of the chunk
    message.includes('Expected a JavaScript module script') ||
    // WebKit's wording for the same MIME rejection: "'text/html' is not a valid
    // JavaScript MIME type." Different enough from the Chromium sentence above
    // that it needs its own clause — missing it meant every iOS visitor caught by
    // a deploy got the error screen instead of the reload.
    message.includes('is not a valid JavaScript MIME type') ||
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

/**
 * The exact wording each engine uses when a `fetch()` never produced a response.
 *
 * These are whole messages, not fragments — see `isDroppedRequestError` for why
 * that matters.
 */
const DROPPED_REQUEST_MESSAGES = [
  // Safari / WebKit — the wording behind the DashboardPage reports
  'Load failed',
  // Chrome / Edge
  'Failed to fetch',
  // Firefox
  'NetworkError when attempting to fetch resource.',
]

/**
 * True when an error is a request that never reached the server, or whose answer
 * never got back.
 *
 * The user went through a tunnel, closed the tab mid-request, or (on iOS Safari,
 * which is where most of these come from) backgrounded the page while a fetch was
 * still open and WebKit tore the connection down. Every caller already handles it:
 * DashboardPage, for one, catches it and shows "Failed to load your profiles.
 * Please try again." So the browser is telling us about someone's wifi, and there
 * is no code change that would make it stop.
 *
 * Matched with `endsWith` rather than `includes`, because the browser's phrasing
 * is a substring of messages we throw ourselves for a response that *did* arrive
 * with an error status — `Failed to fetch (500)`, `Failed to fetch embed`,
 * `Failed to fetch sharing status`. Those mean our API is broken and have to keep
 * reporting; only the bare browser message is dropped.
 *
 * A real outage — the API unreachable for everyone — is not what this hides: that
 * shows up in uptime and Netlify monitoring, where it isn't buried under one event
 * per flaky connection.
 */
export function isDroppedRequestError(message: string): boolean {
  const trimmed = message.trim()
  return (
    DROPPED_REQUEST_MESSAGES.some(wording => trimmed.endsWith(wording)) ||
    // A request we cancelled ourselves, and axios-era wording kept from the
    // filter this replaced. Neither phrase appears in an error we throw.
    trimmed.includes('AbortError') ||
    trimmed.includes('Network Error')
  )
}

/**
 * The text every filter below is matched against.
 *
 * Both sources are read because either one alone can be empty. Errors captured by
 * the global handler often arrive with no `originalException` — the injected-script
 * TypeError above is one of them — and then the message survives only on the event.
 * Reading one source would drop an error from a filter purely because of how it
 * happened to be captured, which is invisible and very annoying to debug.
 */
export function sentryErrorMessage(event: Sentry.ErrorEvent, hint?: Sentry.EventHint): string {
  return [
    hint?.originalException?.toString() || '',
    event.exception?.values?.[0]?.value || '',
  ].join(' ')
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

      // A search puts the artist name in the URL (/?q=artist), and Sentry attaches the page URL
      // to every event. Strip the query string: the route is what makes an error diagnosable,
      // and zero-result searches already report themselves server-side with a deduplicated
      // `search_query` tag, which is a better signal than a stray URL on an unrelated crash.
      if (event.request?.url) {
        event.request.url = event.request.url.split('?')[0]
      }

      const errorMessage = sentryErrorMessage(event, hint)

      // Classified BEFORE the dropped-request filter so a stale-build failure can
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

      // Somebody's connection dropped mid-request. Handled in the UI already.
      if (isDroppedRequestError(errorMessage)) {
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
