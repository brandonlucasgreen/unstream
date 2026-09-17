// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBuildFreshness } from '../../src/hooks/useBuildFreshness'
import * as buildFreshness from '../../src/services/buildFreshness'
import type { DeployedBuild } from '../../src/services/buildFreshness'

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useBuildFreshness', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_APP_VERSION', 'build-a')
    setVisibility('visible')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('does not spawn an overlapping fetch while one is already in flight', async () => {
    let resolveFetch: (value: DeployedBuild | null) => void = () => {}
    const spy = vi
      .spyOn(buildFreshness, 'fetchDeployedBuild')
      .mockImplementation(
        () =>
          new Promise<DeployedBuild | null>((resolve) => {
            resolveFetch = resolve
          })
      )

    renderHook(() => useBuildFreshness())

    // Mount fires the first check, which never resolves until we tell it to.
    expect(spy).toHaveBeenCalledTimes(1)

    // A rapid flurry of visibility toggles (tab switched back and forth) while that probe is
    // still in flight must not each spawn their own fetch.
    act(() => {
      setVisibility('hidden')
      setVisibility('visible')
      setVisibility('hidden')
      setVisibility('visible')
    })

    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFetch(null)
      await Promise.resolve()
    })

    // Once the in-flight probe has settled, a later toggle is free to fetch again.
    act(() => {
      setVisibility('visible')
    })

    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not show the banner from the mount check alone, even when it is stale', async () => {
    const stale: DeployedBuild = { id: 'build-b', builtAt: '2020-01-01T00:00:00.000Z' }
    vi.spyOn(buildFreshness, 'fetchDeployedBuild').mockResolvedValue(stale)

    const { result } = renderHook(() => useBuildFreshness())

    await act(async () => {
      await Promise.resolve()
    })

    // A fresh tab that booted an old service-worker precache must not flash the banner on its
    // very first paint — only a tab that's still behind on a later check has earned it.
    expect(result.current.isStale).toBe(false)
  })

  it('shows the banner once a check after the mount check confirms it is still stale', async () => {
    const stale: DeployedBuild = { id: 'build-b', builtAt: '2020-01-01T00:00:00.000Z' }
    vi.spyOn(buildFreshness, 'fetchDeployedBuild').mockResolvedValue(stale)

    const { result } = renderHook(() => useBuildFreshness())

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.isStale).toBe(false)

    // Returning to the tab triggers the next check; it's this one, not the mount check, that's
    // allowed to settle 'stale'.
    await act(async () => {
      setVisibility('hidden')
      setVisibility('visible')
      await Promise.resolve()
    })

    expect(result.current.isStale).toBe(true)
  })
})
