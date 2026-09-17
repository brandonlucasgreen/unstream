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
 *
 * The mount check's own verdict is never shown as 'stale', only recorded. A brand-new tab can
 * still boot an old service-worker precache — the worker installed on an earlier visit serves
 * its cached shell before its own update check has run — which reads as a day behind the instant
 * the page paints, even though this tab has not been open long enough to be the long-lived-tab
 * case the banner exists for. Requiring a second check (the hourly poll, or a visibilitychange)
 * to confirm 'stale' before it renders means the banner only reaches a tab that's actually
 * stayed behind, not one still finishing its first paint.
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
    // Guards against overlapping fetches: a fast visibilitychange/interval collision (tab
    // switched back and forth before the in-flight probe resolves) would otherwise fire a
    // second fetch on top of the first instead of just skipping it.
    let inFlight = false
    // Only the mount check gets this suppression; every later check is free to settle 'stale'.
    let bootCheckDone = false

    const check = async () => {
      // Once stale, stop asking. The answer can only change by this tab reloading, which ends
      // this component's life anyway.
      if (settled || inFlight) return
      inFlight = true
      const isBootCheck = !bootCheckDone
      try {
        const deployed = await fetchDeployedBuild(controller.signal)
        if (controller.signal.aborted) return
        // A null probe yields 'unknown', which leaves the banner hidden. Not folded into
        // 'fresh': see the note on FreshnessVerdict.
        const next = freshnessVerdict(running, deployed, Date.now())
        if (next === 'stale' && isBootCheck) {
          // Leave `settled` false and the verdict at whatever it was — 'unknown' on first
          // render — so a later check still runs and can confirm it.
          setVerdict('unknown')
        } else {
          if (next === 'stale') settled = true
          setVerdict(next)
        }
      } finally {
        inFlight = false
        bootCheckDone = true
      }
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
