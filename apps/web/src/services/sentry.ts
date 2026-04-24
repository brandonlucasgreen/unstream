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

  Sentry.init({
    dsn,
    environment,
    release: version,
    
    // Basic React Router integration for context
    integrations: [
      Sentry.browserTracingIntegration(),
    ],

    // Sample rate for error events (100% - capture all errors)
    tracesSampleRate: 0.0, // No performance monitoring by default
    profilesSampleRate: 0.0,

    // Don't send request data, cookies, or headers by default
    sendDefaultPii: false,

    // Filter out known non-critical errors
    beforeSend(event, hint) {
      // Don't send errors in development (let console handles it)
      if (environment === 'development') {
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

  console.log('Sentry initialized', {
    environment,
    version,
    dsn: dsn.substring(0, 10) + '...',
  })
}

/**
 * Capture a test error for verification
 * Only works in development to avoid sending test errors to Sentry
 */
export function captureTestError(): void {
  const environment = import.meta.env.VITE_SENTRY_ENV || import.meta.env.MODE

  if (environment !== 'development') {
    console.warn('captureTestError should only be used in development')
    return
  }

  try {
    throw new Error(`[Sentry Test] This is a test error from ${environment}. If you see this in Sentry, the setup worked!`)
  } catch (error) {
    Sentry.captureException(error)
  }
}
