import { useBuildFreshness } from '../hooks/useBuildFreshness'

/**
 * Offers a refresh to a tab that's more than a day behind the live build.
 *
 * Prompts rather than reloads. A forced reload would throw away whatever the person was in the
 * middle of — this route list is reachable from a half-finished edit form — and the failure it
 * prevents is already recovered from by `lazyWithRetry` if they walk into it. So the deal is:
 * tell them, let them pick the moment, and stay out of the way if they'd rather not.
 */
export function StaleBuildBanner() {
  const { isStale, dismiss } = useBuildFreshness()

  if (!isStale) return null

  return (
    <div
      // polite, not assertive: this is worth reading at the next natural pause, and it is not
      // an error. assertive would interrupt a screen reader mid-sentence for a housekeeping note.
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-border bg-bg-secondary px-4 py-3 text-center"
    >
      <p className="text-sm text-text-muted">
        A newer version of Unstream is available.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-accent-primary px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-primary/90"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text-primary"
        >
          Not now
        </button>
      </div>
    </div>
  )
}
