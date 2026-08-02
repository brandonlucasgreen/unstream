import { describe, it, expect } from 'vitest';
import { Sentry, sentryErrorMessage, isStaleBuildAssetError, isInjectedNativeBridgeError } from '../../src/services/sentry';

/**
 * Every filter in `beforeSend` matches against the string this builds, so it has to
 * find the message wherever Sentry happened to put it. An error thrown by our own
 * code arrives with an `originalException`; one caught by the global handler often
 * doesn't, and carries its message on the event instead.
 *
 * These cover both shapes, and assert the pre-existing filters — not just the new
 * bridge one — still match when the message only arrives on the event.
 */
const eventWith = (value?: string): Sentry.ErrorEvent =>
  ({ exception: value ? { values: [{ value }] } : undefined }) as Sentry.ErrorEvent;

describe('sentryErrorMessage', () => {
  it('reads the thrown exception', () => {
    expect(sentryErrorMessage(eventWith(), { originalException: new Error('boom') }))
      .toContain('Error: boom');
  });

  it('reads the event when there is no originalException', () => {
    expect(sentryErrorMessage(eventWith('TypeError: nope'), {})).toContain('TypeError: nope');
  });

  it('reads the event when there is no hint at all', () => {
    expect(sentryErrorMessage(eventWith('TypeError: nope'))).toContain('TypeError: nope');
  });

  it('keeps both when both are present', () => {
    const message = sentryErrorMessage(eventWith('from the event'), {
      originalException: new Error('from the throw'),
    });
    expect(message).toContain('from the throw');
    expect(message).toContain('from the event');
  });

  it('matches nothing when the error carries no message anywhere', () => {
    // Joining two empty strings leaves a single space, so guard against a filter
    // deciding that blank message looks like one of its patterns.
    const message = sentryErrorMessage(eventWith(), {});
    expect(isStaleBuildAssetError(message)).toBe(false);
    expect(isInjectedNativeBridgeError(message)).toBe(false);
    expect(message.includes('Network Error')).toBe(false);
    expect(message.includes('AbortError')).toBe(false);
  });
});

describe('the pre-existing filters, against an event-only message', () => {
  it('still classifies a stale build asset error', () => {
    const message = sentryErrorMessage(
      eventWith('TypeError: Failed to fetch dynamically imported module: https://unstream.stream/assets/LoginPage-DWG6zFx3.js'),
      {}
    );
    expect(isStaleBuildAssetError(message)).toBe(true);
  });

  it('still spots the benign network errors', () => {
    expect(sentryErrorMessage(eventWith('Network Error'), {}).includes('Network Error')).toBe(true);
    expect(sentryErrorMessage(eventWith('AbortError: Fetch is aborted'), {}).includes('AbortError')).toBe(true);
  });

  it('still catches the injected bridge error in its reported shape', () => {
    // The reported event: global handler, no originalException.
    const message = sentryErrorMessage(
      eventWith("TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers')"),
      {}
    );
    expect(isInjectedNativeBridgeError(message)).toBe(true);
  });
});
