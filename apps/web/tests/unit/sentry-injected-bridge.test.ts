import { describe, it, expect } from 'vitest';
import { isInjectedNativeBridgeError } from '../../src/services/sentry';

/**
 * An iOS in-app browser injects its own script into the page it opens. That script
 * talks to the host app over `window.webkit.messageHandlers`, and throws when the
 * bridge isn't there. Because the injection has no source URL of its own, the stack
 * blames `https://unstream.stream/:1` and the event lands in our Sentry project.
 *
 * These are the messages WebKit produces for that access.
 */
describe('isInjectedNativeBridgeError', () => {
  it('matches the reported homepage error', () => {
    expect(isInjectedNativeBridgeError(
      "TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers')"
    )).toBe(true);
  });

  it('matches a named handler being posted to', () => {
    expect(isInjectedNativeBridgeError(
      "TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers.analytics.postMessage')"
    )).toBe(true);
  });

  it('matches the null wording older WebKit uses', () => {
    expect(isInjectedNativeBridgeError(
      "TypeError: null is not an object (evaluating 'webkit.messageHandlers')"
    )).toBe(true);
  });

  it('leaves our own errors alone', () => {
    expect(isInjectedNativeBridgeError(
      'TypeError: Failed to fetch dynamically imported module: https://unstream.stream/assets/LoginPage-DWG6zFx3.js'
    )).toBe(false);
    expect(isInjectedNativeBridgeError(
      "TypeError: undefined is not an object (evaluating 'artist.releases.length')"
    )).toBe(false);
  });
});
