import { describe, it, expect } from 'vitest';
import { Sentry, sentryErrorMessage, isDroppedRequestError, isStaleBuildAssetError } from '../../src/services/sentry';

const eventWith = (value?: string): Sentry.ErrorEvent =>
  ({ exception: value ? { values: [{ value }] } : undefined }) as Sentry.ErrorEvent;

/**
 * A `fetch()` that never produced a response. The reported case was the dashboard's
 * two mount-time requests failing in Safari, which words it "Load failed" — nothing
 * in the message says "network", so it read like an application TypeError.
 */
describe('isDroppedRequestError', () => {
  it('matches the Safari wording behind the DashboardPage reports', () => {
    expect(isDroppedRequestError('TypeError: Load failed')).toBe(true);
  });

  it('matches the reported event in its captured shape', () => {
    // Thrown by our own code, so both sources carry the message and the joined
    // string repeats it.
    const message = sentryErrorMessage(eventWith('Load failed'), {
      originalException: new TypeError('Load failed'),
    });
    expect(isDroppedRequestError(message)).toBe(true);
  });

  it('matches the Chrome/Edge and Firefox wordings', () => {
    expect(isDroppedRequestError('TypeError: Failed to fetch')).toBe(true);
    expect(isDroppedRequestError('TypeError: NetworkError when attempting to fetch resource.')).toBe(true);
  });

  it('matches a cancelled request', () => {
    expect(isDroppedRequestError('AbortError: Fetch is aborted')).toBe(true);
    expect(isDroppedRequestError('Network Error')).toBe(true);
  });

  it('keeps reporting a response that arrived with an error status', () => {
    // The browser's phrasing is a substring of these. They mean our API answered
    // and answered badly — a real bug, and the whole reason this matches on the
    // end of the message rather than anywhere in it.
    expect(isDroppedRequestError('Error: Failed to fetch (500)')).toBe(false);
    expect(isDroppedRequestError('Error: Failed to fetch embed')).toBe(false);
    expect(isDroppedRequestError('Error: Failed to fetch sharing status')).toBe(false);
    expect(isDroppedRequestError('Error: Failed to load claimed profiles')).toBe(false);
    expect(isDroppedRequestError('Error: Failed to load saved artists')).toBe(false);
  });

  it('leaves ordinary application errors alone', () => {
    expect(isDroppedRequestError('TypeError: Cannot read properties of undefined')).toBe(false);
    expect(isDroppedRequestError('Invalid login credentials')).toBe(false);
  });

  it('matches nothing when the error carries no message anywhere', () => {
    expect(isDroppedRequestError(sentryErrorMessage(eventWith(), {}))).toBe(false);
  });

  it('does not claim a stale build asset error', () => {
    // beforeSend classifies stale builds first, but the two must not overlap
    // either — a deploy breaking every open tab has to stay visible.
    const staleChunk = 'TypeError: Failed to fetch dynamically imported module: https://unstream.stream/assets/LoginPage-DWG6zFx3.js';
    expect(isStaleBuildAssetError(staleChunk)).toBe(true);
    expect(isDroppedRequestError(staleChunk)).toBe(false);
    expect(isDroppedRequestError('TypeError: Importing a module script failed.')).toBe(false);
    expect(isDroppedRequestError('Unable to preload CSS for /assets/ArtistEditPage-Bq1x9fLm.css')).toBe(false);
  });
});
