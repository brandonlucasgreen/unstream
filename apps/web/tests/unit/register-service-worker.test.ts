// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { addBreadcrumb } from '@sentry/react';
import { registerServiceWorker, checkForUpdate } from '../../src/services/registerServiceWorker';

vi.mock('@sentry/react', () => ({ addBreadcrumb: vi.fn() }));

/**
 * Google's crawler stubs out navigator.serviceWorker.register so it rejects
 * `Error: Rejected`, and vite-plugin-pwa's injected registerSW.js never caught
 * it — so a Read-Aloud fetch of the homepage arrived in Sentry looking like a
 * person hitting an error on their first page view. A declined registration is
 * a breadcrumb, not an event.
 */
const register = vi.fn();
const update = vi.fn<() => Promise<unknown>>();
/** The registration register() resolves with; watchForUpdates calls .update() on it. */
const registration = { update } as unknown as ServiceWorkerRegistration;
// Registration is deferred to window 'load'. Capturing the listener beats
// dispatching the real event, which would also re-run listeners left behind by
// earlier tests, against a navigator they no longer expect.
const listen = vi.spyOn(window, 'addEventListener');
const docListen = vi.spyOn(document, 'addEventListener');

function stubServiceWorker(value: unknown) {
  Object.defineProperty(navigator, 'serviceWorker', {
    value,
    configurable: true,
    writable: true,
  });
}

function setReadyState(state: DocumentReadyState) {
  Object.defineProperty(document, 'readyState', { value: state, configurable: true });
}

/** Runs this test's 'load' listener, as page load would. */
async function fireLoad() {
  for (const [type, handler] of listen.mock.calls) {
    if (type === 'load') (handler as EventListener)(new Event('load'));
  }
  await settle();
}

/** Lets the rejection handler attached inside the registration run. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Sets the tab's visibility and runs the listener registered by THIS test.
 *
 * Captured rather than dispatched, for the same reason as `fireLoad` above: every test
 * registers another listener on the shared jsdom document, and a real event would re-run all
 * of them against a registration they no longer expect.
 */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  const handlers = docListen.mock.calls.filter(([type]) => type === 'visibilitychange');
  const latest = handlers[handlers.length - 1];
  if (latest) (latest[1] as EventListener)(new Event('visibilitychange'));
}

beforeEach(() => {
  register.mockReset().mockResolvedValue(registration);
  update.mockReset().mockResolvedValue(registration);
  vi.useRealTimers();
  listen.mockClear();
  docListen.mockClear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.mocked(addBreadcrumb).mockClear();
  listen.mockClear();
  stubServiceWorker({ register });
  setReadyState('loading');
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('registerServiceWorker', () => {
  it('registers /sw.js at the root scope once the page has loaded', async () => {
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();

    await fireLoad();

    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it('registers straight away when load has already fired', async () => {
    // A listener added after 'load' never runs, which would leave the app with
    // no service worker and nothing to show for it.
    setReadyState('complete');

    registerServiceWorker();
    await settle();

    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('records a declined registration as a breadcrumb rather than an error', async () => {
    register.mockRejectedValue(new Error('Rejected'));

    registerServiceWorker();
    await fireLoad();

    // Reaching the breadcrumb is the proof the rejection was consumed. Drop the
    // .catch() and this rejection goes unhandled, which is the whole bug.
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'pwa',
        level: 'info',
        data: { reason: 'Rejected' },
      })
    );
  });

  it('does nothing where the browser has no service worker support', async () => {
    Reflect.deleteProperty(navigator, 'serviceWorker');

    expect(() => registerServiceWorker()).not.toThrow();
    await fireLoad();

    expect(register).not.toHaveBeenCalled();
  });
});

/**
 * register() triggers one check per page load, but this is a SPA — route changes are not
 * navigations, so a tab left open never asks again. That is how a browser ends up serving a
 * precached build whose chunks the CDN has since deleted.
 */
describe('checking for a new service worker', () => {
  it('re-checks when the tab comes back to the foreground', async () => {
    registerServiceWorker();
    await fireLoad();
    expect(update).not.toHaveBeenCalled();

    // Long enough to clear the throttle that starts at registration.
    vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
    setVisibility('hidden');
    setVisibility('visible');

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('does not check while the tab is going into the background', async () => {
    registerServiceWorker();
    await fireLoad();
    vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));

    setVisibility('hidden');

    // Spending a request on a tab nobody is looking at is the one case this shouldn't cover.
    expect(update).not.toHaveBeenCalled();
  });

  it('throttles a tab being flipped between repeatedly', async () => {
    registerServiceWorker();
    await fireLoad();
    vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));

    for (let i = 0; i < 5; i++) {
      setVisibility('hidden');
      setVisibility('visible');
    }

    // Five flips, one request — the throttle re-arms on the first.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('checks again once the throttle window has passed', async () => {
    registerServiceWorker();
    await fireLoad();

    vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
    setVisibility('hidden');
    setVisibility('visible');
    vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
    setVisibility('hidden');
    setVisibility('visible');

    expect(update).toHaveBeenCalledTimes(2);
  });

  it('survives a check that fails offline', async () => {
    // update() rejects when the browser can't reach the network. The call site lets that promise
    // float, so an escaping rejection becomes an unhandled rejection — which Sentry's global
    // handler reports at error level, turning someone's train journey into an issue.
    update.mockRejectedValue(new Error('Failed to fetch'));

    await expect(checkForUpdate(registration)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalled();
  });
});
