// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearApiResponseCache, deleteApiCacheBucket } from '../../src/services/clearApiResponseCache';

/**
 * The service worker used to cache every /api/ GET into a bucket named `api-cache`,
 * authenticated ones included. Dropping the runtimeCaching rule stops new writes but
 * leaves the bucket on every install that already has one, and with the route gone
 * Workbox's expiry plugin never runs again — so those entries stop expiring instead of
 * expiring sooner. Deleting the bucket by name is what actually clears them.
 */

const deleteBucket = vi.fn<(name: string) => Promise<boolean>>();
const swListen = vi.fn<(type: string, handler: EventListener) => void>();

function stubCacheStorage(value: unknown) {
  Object.defineProperty(window, 'caches', { value, configurable: true, writable: true });
}

/** Runs the handler registered for 'controllerchange', as the new worker claiming the page would. */
function fireControllerChange() {
  for (const [type, handler] of swListen.mock.calls) {
    if (type === 'controllerchange') handler(new Event('controllerchange'));
  }
}

/** Lets the floating promise inside the delete settle. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  deleteBucket.mockReset().mockResolvedValue(true);
  swListen.mockReset();
  stubCacheStorage({ delete: deleteBucket });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { addEventListener: swListen },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, 'caches');
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('clearApiResponseCache', () => {
  it('deletes the api-cache bucket', async () => {
    clearApiResponseCache();
    await settle();

    expect(deleteBucket).toHaveBeenCalledWith('api-cache');
  });

  it('deletes it again when a new worker claims the page', async () => {
    // The load that installs the new worker is still controlled by the old one, so the
    // removed rule can write after the startup delete has already run.
    clearApiResponseCache();
    await settle();
    expect(deleteBucket).toHaveBeenCalledTimes(1);

    fireControllerChange();
    await settle();

    expect(deleteBucket).toHaveBeenCalledTimes(2);
    expect(deleteBucket).toHaveBeenLastCalledWith('api-cache');
  });

  it('leaves other buckets alone', async () => {
    // The precache buckets hold the app shell. Clearing those would cost every
    // returning visitor a cold load for no privacy gain.
    clearApiResponseCache();
    fireControllerChange();
    await settle();

    for (const [name] of deleteBucket.mock.calls) {
      expect(name).toBe('api-cache');
    }
  });

  it('does nothing where the browser has no Cache Storage', async () => {
    Reflect.deleteProperty(window, 'caches');

    expect(() => clearApiResponseCache()).not.toThrow();
    await settle();

    expect(deleteBucket).not.toHaveBeenCalled();
    // No listener either — with no Cache Storage there is nothing for a handoff to clear.
    expect(swListen).not.toHaveBeenCalled();
  });

  it('swallows a rejection from a browser that blocks site data', async () => {
    // Reaching Cache Storage throws outright when site data is blocked. Such a browser
    // never wrote the bucket, so this is a decline rather than a failure — and both
    // calls in clearApiResponseCache are floating, so a rejection escaping here becomes
    // an unhandled rejection, which Sentry's global handler reports at error level.
    deleteBucket.mockRejectedValue(new Error('The operation is insecure.'));

    await expect(deleteApiCacheBucket()).resolves.toBeUndefined();
  });
});
