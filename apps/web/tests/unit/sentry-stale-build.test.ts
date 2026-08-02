import { describe, it, expect } from 'vitest';
import { isStaleBuildAssetError } from '../../src/services/sentry';

/**
 * A deploy replaces every hashed chunk filename. A tab still running the previous
 * build then asks for a chunk that no longer exists, and because Netlify's SPA
 * catch-all answers `200 text/html` instead of 404, the browser rejects it as a
 * module script. These are the real strings each engine produces for that.
 */
describe('isStaleBuildAssetError', () => {
  it('matches the Chrome/Edge dynamic import failure', () => {
    expect(isStaleBuildAssetError(
      'TypeError: Failed to fetch dynamically imported module: https://unstream.stream/assets/LoginPage-DWG6zFx3.js'
    )).toBe(true);
  });

  it('matches the Firefox wording', () => {
    expect(isStaleBuildAssetError(
      'TypeError: error loading dynamically imported module: https://unstream.stream/assets/LoginPage-DWG6zFx3.js'
    )).toBe(true);
  });

  it('matches the Safari wording', () => {
    expect(isStaleBuildAssetError('TypeError: Importing a module script failed.')).toBe(true);
  });

  it('matches the MIME rejection the SPA catch-all causes', () => {
    expect(isStaleBuildAssetError(
      "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of 'text/html'."
    )).toBe(true);
  });

  it("matches Vite's CSS preload failure", () => {
    expect(isStaleBuildAssetError(
      'Unable to preload CSS for /assets/ArtistEditPage-Bq1x9fLm.css'
    )).toBe(true);
  });

  it('does not match ordinary application errors', () => {
    expect(isStaleBuildAssetError('TypeError: Cannot read properties of undefined')).toBe(false);
    expect(isStaleBuildAssetError('AbortError: The operation was aborted')).toBe(false);
    expect(isStaleBuildAssetError('Invalid login credentials')).toBe(false);
    expect(isStaleBuildAssetError('')).toBe(false);
  });

  it('does not match a fetch failure for a non-module resource', () => {
    // Plain `fetch()` failures say "Failed to fetch" without the module clause.
    // Treating those as a stale build would misattribute every flaky API call.
    expect(isStaleBuildAssetError('TypeError: Failed to fetch')).toBe(false);
  });
});
