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
})
