import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchDeployedBuild,
  freshnessVerdict,
  BUILD_ID_URL,
  STALE_AFTER_MS,
} from '../../src/services/buildFreshness'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-08-22T12:00:00.000Z')

/** A deployed build whose `builtAt` is `ageMs` old relative to NOW. */
function deployed(id: string, ageMs: number) {
  return { id, builtAt: new Date(NOW - ageMs).toISOString() }
}

describe('freshnessVerdict', () => {
  it('is fresh when this tab is running the deployed build', () => {
    expect(freshnessVerdict('abc123', deployed('abc123', 90 * HOUR), NOW)).toBe('fresh')
  })

  it('is stale when a different build has been live for more than a day', () => {
    expect(freshnessVerdict('old', deployed('new', 25 * HOUR), NOW)).toBe('stale')
  })

  it('holds off while the newer build is younger than the threshold', () => {
    // The whole point of the delay: a deploy that just landed must not interrupt anyone,
    // because lazyWithRetry already recovers if they walk into a missing chunk.
    expect(freshnessVerdict('old', deployed('new', 1 * HOUR), NOW)).toBe('fresh')
    expect(freshnessVerdict('old', deployed('new', 23 * HOUR), NOW)).toBe('fresh')
  })

  it('reads the threshold from the deployed build age, not from elapsed polling time', () => {
    // Teeth: these two bracket STALE_AFTER_MS exactly. An implementation that ignored the
    // threshold, compared against a hardcoded different number, or measured from "when this
    // tab first noticed" would fail one of them.
    expect(freshnessVerdict('old', deployed('new', STALE_AFTER_MS - 1), NOW)).toBe('fresh')
    expect(freshnessVerdict('old', deployed('new', STALE_AFTER_MS + 1), NOW)).toBe('stale')
  })

  it('honours a caller-supplied threshold', () => {
    expect(freshnessVerdict('old', deployed('new', 2 * HOUR), NOW, 1 * HOUR)).toBe('stale')
    expect(freshnessVerdict('old', deployed('new', 2 * HOUR), NOW, 3 * HOUR)).toBe('fresh')
  })

  it('is unknown, never stale, when there is nothing to compare', () => {
    // A local or unversioned build must never decide it is out of date.
    expect(freshnessVerdict(null, deployed('new', 99 * HOUR), NOW)).toBe('unknown')
    // A probe that came back empty says nothing about this tab. Folding this into 'fresh' or
    // 'stale' is the "never cache uncertainty" bug; keep it its own answer.
    expect(freshnessVerdict('old', null, NOW)).toBe('unknown')
  })

  it('is unknown when the deployed build cannot be dated', () => {
    expect(freshnessVerdict('old', { id: 'new', builtAt: 'not-a-date' }, NOW)).toBe('unknown')
    expect(freshnessVerdict('old', { id: 'new', builtAt: '' }, NOW)).toBe('unknown')
  })

  it('does not treat a clock skewed behind the deploy as stale', () => {
    // A device clock set in the past makes builtAt look like the future. Negative age must not
    // sail past a positive threshold.
    expect(freshnessVerdict('old', deployed('new', -50 * HOUR), NOW)).toBe('fresh')
  })
})

describe('fetchDeployedBuild', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(impl: typeof fetch) {
    const spy = vi.fn(impl)
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('returns the build and bypasses every cache on the way', async () => {
    const spy = stubFetch(async () =>
      new Response(JSON.stringify({ id: 'abc', builtAt: '2026-08-22T00:00:00.000Z' }), {
        status: 200,
      })
    )

    await expect(fetchDeployedBuild()).resolves.toEqual({
      id: 'abc',
      builtAt: '2026-08-22T00:00:00.000Z',
    })

    // Load-bearing: a cached response echoes this tab's own build back to it forever, so the
    // banner would never appear. Pin the option rather than trusting a comment about it.
    const [url, init] = spy.mock.calls[0]
    expect(url).toBe(BUILD_ID_URL)
    expect(init).toMatchObject({ cache: 'no-store' })
  })

  it('answers null — not a guess — for every kind of failure', async () => {
    stubFetch(async () => new Response('', { status: 500 }))
    await expect(fetchDeployedBuild()).resolves.toBeNull()

    stubFetch(async () => new Response('', { status: 404 }))
    await expect(fetchDeployedBuild()).resolves.toBeNull()

    stubFetch(async () => new Response('<!doctype html>', { status: 200 }))
    await expect(fetchDeployedBuild()).resolves.toBeNull()

    stubFetch(async () => {
      throw new TypeError('Load failed')
    })
    await expect(fetchDeployedBuild()).resolves.toBeNull()
  })

  it('rejects a body missing either field rather than half-trusting it', async () => {
    stubFetch(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }))
    await expect(fetchDeployedBuild()).resolves.toBeNull()

    stubFetch(async () => new Response(JSON.stringify({ builtAt: 'x' }), { status: 200 }))
    await expect(fetchDeployedBuild()).resolves.toBeNull()

    stubFetch(async () => new Response(JSON.stringify({ id: 7, builtAt: 8 }), { status: 200 }))
    await expect(fetchDeployedBuild()).resolves.toBeNull()
  })

  it('a failed probe cannot produce a banner', async () => {
    // The two halves together: this is the property that matters, so assert it end to end.
    stubFetch(async () => {
      throw new TypeError('Load failed')
    })
    const build = await fetchDeployedBuild()
    expect(freshnessVerdict('old-build', build, NOW)).toBe('unknown')
  })
})
