import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

/**
 * Says so when a save a fan asked for before signing in didn't go through afterwards, with a
 * retry. Mounted once, outside the router, because a sign-in can land anywhere — the page they
 * were on (password), or their account home (magic link). Before this the pending save was
 * deleted on read and a failure was silent: signed in, artist unsaved, no sign of either.
 */
export function PendingSaveNotice() {
  const { failedPendingSave, retryPendingSave, dismissPendingSave } = useAuth()
  const [retrying, setRetrying] = useState(false)

  if (!failedPendingSave) return null

  const name = failedPendingSave.artistName || 'this artist'

  const handleRetry = async () => {
    setRetrying(true)
    try {
      await retryPendingSave()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-border bg-bg-secondary px-4 py-3 text-center"
    >
      <p className="text-sm text-text-primary">
        You're signed in, but we couldn't save {name}.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50"
        >
          {retrying ? 'Saving…' : 'Try again'}
        </button>
        <button
          type="button"
          onClick={dismissPendingSave}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text-primary"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
