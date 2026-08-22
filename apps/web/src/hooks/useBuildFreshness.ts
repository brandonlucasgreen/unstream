import { useCallback, useEffect, useState } from 'react'
import {
  fetchDeployedBuild,
  freshnessVerdict,
  runningBuildId,
  type FreshnessVerdict,
} from '../services/buildFreshness'

/** How often a visible tab re-checks. Cheap: one no-store GET of a two-field JSON file. */
const POLL_INTERVAL_MS = 60 * 60 * 1000

/**
 * True once this tab is more than a day behind the live build, until the person dismisses it.
 *
 * Checks on mount, whenever the tab is brought back to the foreground, and hourly while it
 * stays visible. The foreground check is the one that matters on a phone: iOS suspends timers
 * in background tabs, so a tab that sat in the app switcher for a week fires no interval at all
 * — but it does fire `visibilitychange` the moment the person returns to it, which is exactly
 * when they're about to navigate into a chunk that no longer exists.
 */
export function useBuildFreshness(): { isStale: boolean; dismiss: () => void } {
  const [verdict, setVerdict] = useState<FreshnessVerdict>('unknown')
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const running = runningBuildId()
    // A local or unversioned build has nothing to compare against, so don't poll at all —
    // otherwise every `npm run dev` session fetches a file that isn't there once an hour.
    if (!running) return

    const controller = new AbortController()
    // Kept in the closure rather than read back off state: the effect runs once, and reading
    // the latest verdict from render would mean either re-running the effect (tearing down its
    // own listeners) or writing a ref during render.
    let settled = false

    const check = async () => {
      // Once stale, stop asking. The answer can only change by this tab reloading, which ends
      // this component's life anyway.
      if (settled) return
      const deployed = await fetchDeployedBuild(controller.signal)
      if (controller.signal.aborted) return
      // A null probe yields 'unknown', which leaves the banner hidden. Not folded into 'fresh':
      // see the note on FreshnessVerdict.
      const next = freshnessVerdict(running, deployed, Date.now())
      if (next === 'stale') settled = true
      setVerdict(next)
    }

    const checkIfVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }

    void check()
    document.addEventListener('visibilitychange', checkIfVisible)
    const interval = setInterval(checkIfVisible, POLL_INTERVAL_MS)

    return () => {
      controller.abort()
      document.removeEventListener('visibilitychange', checkIfVisible)
      clearInterval(interval)
    }
  }, [])

  const dismiss = useCallback(() => setDismissed(true), [])

  return { isStale: verdict === 'stale' && !dismissed, dismiss }
}
