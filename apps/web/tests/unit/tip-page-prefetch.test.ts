import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const okBody = { artist: { id: 'a', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', imageUrl: null }, takingTips: true };
const ok = () => Promise.resolve(new Response(JSON.stringify(okBody), { status: 200 }));

beforeEach(() => { fetchMock.mockReset(); vi.resetModules(); });

describe('tip page prefetch', () => {
  it('joins an in-flight prefetch instead of fetching twice', async () => {
    fetchMock.mockReturnValue(new Promise(res => setTimeout(() => res(new Response(JSON.stringify(okBody), { status: 200 })), 20)));
    const { prefetchTipPage, getTipPageCached } = await import('../../src/services/tips');
    prefetchTipPage('kid-lightbulbs');
    prefetchTipPage('kid-lightbulbs'); // deduped
    const data = await getTipPageCached('kid-lightbulbs');
    expect(data.takingTips).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the just-settled prefetch inside its window, then refetches after eviction', async () => {
    fetchMock.mockImplementation(() => ok());
    const { prefetchTipPage, getTipPageCached } = await import('../../src/services/tips');
    prefetchTipPage('kid-lightbulbs');
    await getTipPageCached('kid-lightbulbs');
    await getTipPageCached('kid-lightbulbs'); // same window → no new fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await new Promise(r => setTimeout(r, 3100)); // eviction timer (3s)
    const again = await getTipPageCached('kid-lightbulbs');
    expect(again.takingTips).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to a live fetch when the prefetch failed', async () => {
    fetchMock.mockImplementation(() => {
      if (fetchMock.mock.calls.length === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return ok();
    });
    const { prefetchTipPage, getTipPageCached } = await import('../../src/services/tips');
    prefetchTipPage('kid-lightbulbs');
    const data = await getTipPageCached('kid-lightbulbs');
    expect(data.takingTips).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
