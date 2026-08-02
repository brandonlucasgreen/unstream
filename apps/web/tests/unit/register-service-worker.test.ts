// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { addBreadcrumb } from '@sentry/react';
import { registerServiceWorker } from '../../src/services/registerServiceWorker';

vi.mock('@sentry/react', () => ({ addBreadcrumb: vi.fn() }));

/**
 * Google's crawler stubs out navigator.serviceWorker.register so it rejects
 * `Error: Rejected`, and vite-plugin-pwa's injected registerSW.js never caught
 * it — so a Read-Aloud fetch of the homepage arrived in Sentry looking like a
 * person hitting an error on their first page view. A declined registration is
 * a breadcrumb, not an event.
 */
const register = vi.fn();
// Registration is deferred to window 'load'. Capturing the listener beats
// dispatching the real event, which would also re-run listeners left behind by
// earlier tests, against a navigator they no longer expect.
const listen = vi.spyOn(window, 'addEventListener');

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

beforeEach(() => {
  register.mockReset().mockResolvedValue({});
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
