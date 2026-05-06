/**
 * Sentry configuration and initialization
 * 
 * DSN should be set via environment variable: VITE_SENTRY_DSN
 * Environment should be set via: VITE_SENTRY_ENV
 * App version should be set via: VITE_APP_VERSION
 */

import * as Sentry from '@sentry/react'

export { Sentry }

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

      // Filter out common benign errors
      const errorMessage = hint?.originalException?.toString() || ''
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
