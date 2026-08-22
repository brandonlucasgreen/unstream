/**
 * Detect that this tab is running a build the site has since replaced.
 *
 * Nothing tells a long-lived tab that it went out of date. The service worker is
 * `registerType: 'autoUpdate'`, so a new deploy's worker claims the live page without
 * reloading it — the page keeps its old JavaScript while the precache holds the new build.
 * The first thing the person notices is a route that won't open, because the chunk its old
 * `index.html` named no longer exists.
 *
 * `lazyWithRetry` already recovers from that *reactively*, once they've hit it. This module is
 * the proactive half: it asks which build is live and, when we're a day behind it, lets the UI
 * offer a refresh before they walk into the failure.
 */
import { BUILD_ID_URL, STALE_AFTER_MS } from './buildFreshnessConstants'

export { BUILD_ID_URL, STALE_AFTER_MS }

/** The shape of the `/build-id.json` emitted by the `unstream-build-id` plugin in vite.config.ts. */
export interface DeployedBuild {
  id: string
  builtAt: string
}

/**
 * `unknown` is a first-class answer, not an error to be flattened into `fresh`.
 *
 * A failed probe — offline, a 500, a body we can't parse — says nothing about whether this tab
 * is current, and the caller must not act on it either way. Collapsing it into `stale` nags
 * people whose connection blipped; collapsing it into `fresh` is the "never cache uncertainty"
 * bug this codebase keeps relearning. Keeping it separate makes the caller decide on purpose.
 */
export type FreshnessVerdict = 'fresh' | 'stale' | 'unknown'

/** The build baked into this bundle at build time, or null when there isn't a real one. */
export function runningBuildId(): string | null {
  const id = import.meta.env.VITE_APP_VERSION
  // 'dev' is the vite.config fallback when no COMMIT_REF exists, and 'unknown' is what
  // sentry.ts reports without one. Neither identifies a deploy, so neither can be compared
  // against one — a local build must never decide it is stale.
  if (!id || id === 'dev' || id === 'unknown') return null
  return id
}

/**
 * Is `running` behind `deployed`, and has it been for longer than `staleAfterMs`?
 *
 * The clock runs from the deployed build's own `builtAt`, not from when this tab first noticed
 * it. A backgrounded iOS tab has its timers suspended, so "how long have I been watching"
 * undercounts by however long the phone was in a pocket — the exact case this is for. Reading
 * the live build's age instead makes the answer independent of whether any interval ever fired.
 *
 * With several deploys in a day this measures from the newest one, so it under-reports how long
 * we've been stale. That direction is deliberate: it means "you are a day behind the build
 * that's live now", which is the thing worth interrupting someone for, and it can't nag about a
 * deploy that went out minutes ago.
 */
export function freshnessVerdict(
  running: string | null,
  deployed: DeployedBuild | null,
  now: number,
  staleAfterMs: number = STALE_AFTER_MS
): FreshnessVerdict {
  if (!running || !deployed?.id) return 'unknown'
  if (running === deployed.id) return 'fresh'

  const builtAt = Date.parse(deployed.builtAt)
  // A build we can't date can't be aged. Reporting 'unknown' rather than 'stale' keeps a
  // malformed file from turning into a banner nobody can explain; we emit this file ourselves,
  // so in practice it means the emitter broke and wants fixing, not that the user should act.
  if (Number.isNaN(builtAt)) return 'unknown'

  return now - builtAt > staleAfterMs ? 'stale' : 'fresh'
}

/**
 * Ask which build is live. Resolves null on any failure — see `FreshnessVerdict`.
 *
 * `cache: 'no-store'` keeps the browser cache out of it, and netlify.toml sends
 * `Cache-Control: no-store` so the CDN can't hand back this tab's own build either. Without
 * both, the probe eventually answers with the very build it's meant to detect a change from.
 */
export async function fetchDeployedBuild(signal?: AbortSignal): Promise<DeployedBuild | null> {
  try {
    const response = await fetch(BUILD_ID_URL, { cache: 'no-store', signal })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object') return null
    const { id, builtAt } = body as Partial<DeployedBuild>
    if (typeof id !== 'string' || typeof builtAt !== 'string') return null
    return { id, builtAt }
  } catch {
    // Offline, aborted, or a body that isn't JSON. All of them mean "no answer", which is
    // what null says. Deliberately not reported: a probe that fails while someone is on a
    // train is routine, and it changes nothing about what we show them.
    return null
  }
}
