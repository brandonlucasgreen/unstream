/**
 * Split out from buildFreshness.ts so tests can import the thresholds without pulling in
 * `import.meta.env`, which only exists once Vite has transformed the module.
 */

/** Emitted by the `unstream-build-id` plugin in vite.config.ts. */
export const BUILD_ID_URL = '/build-id.json'

/**
 * How far behind the live build this tab has to be before it's worth interrupting someone.
 *
 * Not zero on purpose. `lazyWithRetry` already catches the failure this prevents, so the banner
 * is the slower, politer layer — a prompt the moment any deploy lands would interrupt people
 * mid-edit several times a week to protect them from something already handled.
 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000
