// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { importPageOrReload } from '../../src/utils/lazyWithRetry';

/**
 * A deploy renames every hashed chunk, so a tab left open across one asks for a
 * file the new build doesn't have. The wrapper reloads that tab once so it picks
 * up the new index.html — and only once, so a chunk that is genuinely broken
 * lands on the error boundary instead of reloading forever.
 */
const STALE_CHUNK_ERROR = new TypeError(
  'Failed to fetch dynamically imported module: https://unstream.stream/assets/LoginPage-DWG6zFx3.js'
);

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  sessionStorage.clear();
  // jsdom refuses to navigate, so stand in for the whole location object.
  vi.stubGlobal('location', { ...window.location, reload });
});

describe('importPageOrReload', () => {
  it('returns the module when the import succeeds', async () => {
    const page = { default: () => null };
    await expect(importPageOrReload(async () => page)).resolves.toBe(page);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once on a stale-chunk error', async () => {
    const pending = importPageOrReload(async () => {
      throw STALE_CHUNK_ERROR;
    });

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // The promise deliberately never settles while the reload is in flight, so
    // React keeps showing the Suspense fallback rather than the error screen.
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending');
  });

  it('does not reload a second time in the same session', async () => {
    void importPageOrReload(async () => {
      throw STALE_CHUNK_ERROR;
    });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    await expect(
      importPageOrReload(async () => {
        throw STALE_CHUNK_ERROR;
      })
    ).rejects.toBe(STALE_CHUNK_ERROR);
    expect(reload).toHaveBeenCalledTimes(1);
    // Short timeout: if the guard regresses, this hangs on a promise that never
    // settles, and a fast failure beats waiting out the default.
  }, 2000);

  it('lets a later deploy reload again once a load has succeeded', async () => {
    void importPageOrReload(async () => {
      throw STALE_CHUNK_ERROR;
    });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    // The reload landed on a build that can serve its own chunks.
    await importPageOrReload(async () => ({ default: () => null }));

    void importPageOrReload(async () => {
      throw STALE_CHUNK_ERROR;
    });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  it('rethrows a non-stale error untouched', async () => {
    const bug = new TypeError('Cannot read properties of undefined');

    await expect(
      importPageOrReload(async () => {
        throw bug;
      })
    ).rejects.toBe(bug);
    expect(reload).not.toHaveBeenCalled();
  }, 2000);
});
