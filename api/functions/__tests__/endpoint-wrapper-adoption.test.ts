import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which functions are on the shared endpoint wrapper (api/functions/http/endpoint.ts) and which
 * still hand-write their own preflight, CORS, auth, rate limit and JSON parse.
 *
 * The second list only shrinks. To move a function: declare it with `endpoint({...})`, then move
 * its name from NOT_YET to ON_WRAPPER here. A new function goes straight into ON_WRAPPER; this
 * file fails on one that is in neither list, and on a name left in the wrong one.
 */

/** Exports its handler as `withSentry(endpoint({...}, ...))`. */
const ON_WRAPPER = [
  'admin-flags.ts',
  'me-artist-nav.ts',
  'me-collection.ts',
  'me-email.ts',
  'me-feed-token.ts',
  'me-location.ts',
  'me-notifications.ts',
  'me-recent-releases.ts',
  'me-username.ts',
  'saved-artists-sync.ts',
  'search-suggest.ts',
  'user-sharing.ts',
];

/**
 * Still hand-written, grouped by what moving each one takes. The groups are notes for whoever
 * does it; the test only reads the names.
 */
const NOT_YET = [
  // Signed-in, and the wrapper already has their shape (resolveAccountRequest, with or without
  // the second-step check). Left only because they are bigger, or have one wrinkle:
  'saved-artists.ts',
  'me-listening.ts',
  'me-tips.ts',
  'me-email-confirm.ts', // 'strict' tier on the account bucket
  'me-bandcamp.ts', // a second, 'strict' limit on the connect path
  'me-buffer.ts', // its OAuth callback answers with a redirect, not JSON
  'curator-compose.ts',
  'artist-promote.ts',
  'artist-campaigns.ts', // these two share promote-request.ts, a small helper of this same shape
  'artist-promote-assets.ts',
  'me-settings.ts', // needs has_password from Supabase's own user record, fetched alongside the limit

  // Signed-in, checked against Supabase on every request (authenticateBearer, or a private
  // getUser). The wrapper has no mode for that yet; add one with the first of these, limiting
  // by IP before the round trip, as most of them do.
  'artist-releases.ts',
  'artist-profile.ts',
  'claim-artist.ts',
  'me-password.ts',
  'api-key-generate.ts', // also answers in the v1 envelope
  'tips-connect.ts', // these two limit by user after the round trip, and share one methods list
  'tips-settings.ts',
  'artist-auth.ts', // authenticateBearerFast behind an IP limit
  'analytics-stats.ts',

  // Admin. All fit `auth: 'admin'`; admin-catalog-artist answers 403 rather than 401 on purpose.
  'admin-artist-duplicates.ts',
  'admin-catalog-artist.ts',
  'admin-link-suppression.ts',
  'admin-merge-override.ts',
  'admin-release-review.ts',
  'admin-tips.ts',
  'admin-verify.ts',
  'analytics-dashboard.ts',
  'analytics-promote.ts',
  'analytics-traffic.ts',

  // Public. Several hand-write a CORS constant whose headers differ slightly from
  // buildPublicCorsHeaders, and some have no rate limit at all, which the wrapper doesn't allow yet.
  'analytics-app-event.ts',
  'analytics-event.ts',
  'api-status.ts', // v1 envelope, no rate limit
  'platforms-list.ts', // v1 envelope, no rate limit
  'artist-directory.ts',
  'artist-lookup.ts',
  'artist-page.ts',
  'check-releases.ts',
  'desktop-version.ts',
  'embed-bandcamp.ts',
  'newsletter-subscribe.ts',
  'public-saved-artists.ts',
  'release-detail.ts',
  'resolve-url.ts',
  'tips-checkout.ts', // public, 'site' CORS, a different tier for GET and POST
  'search-sources.ts', // the search endpoints time their own rate-limit call for Server-Timing
  'search-musicbrainz.ts',
  'search-stored.ts',

  // The v1 API: an optional API key picks both the CORS answer and the rate-limit tier
  // (authenticateApiKey, checkApiRateLimit). Needs its own mode.
  'artist-lookup-v1.ts',
  'resolve-url-v1.ts',
  'search-sources-v1.ts',

  // Called by our own functions and workflows with INTERNAL_FUNCTION_SECRET (isInternalRequest).
  // No browser calls them, so no CORS. Needs its own mode.
  'bandcamp-sync-background.ts',
  'catalog-artist-background.ts',
  'persist-search-results-background.ts',
  'recatalog-sweep.ts',
  'release-autopost-sweep.ts',
  'tips-review-notify.ts',
  'weekly-analytics-recap.ts',

  // Not JSON in, JSON out, so possibly never: a signature over the raw body, feeds, images.
  'tips-webhook.ts',
  'feed-releases.ts',
  'desktop-appcast.ts',
  'social-card.ts',
  'collection-art.ts',
];

const functionsDir = join(__dirname, '..');
const exportsHandler = /export const handler = withSentry\(/;
const usesWrapper = /export const handler = withSentry\(endpoint\(/;

const source = (name: string) => readFileSync(join(functionsDir, name), 'utf8');
const functionFiles = readdirSync(functionsDir)
  .filter((name) => name.endsWith('.ts'))
  .filter((name) => exportsHandler.test(source(name)));

describe('the endpoint wrapper is adopted one function at a time', () => {
  it('accounts for every function, in exactly one list', () => {
    const listed = [...ON_WRAPPER, ...NOT_YET];
    expect(new Set(listed).size).toBe(listed.length);
    // A name missing here is a new function: put it on the wrapper and in ON_WRAPPER.
    expect([...listed].sort()).toEqual([...functionFiles].sort());
  });

  it.each(ON_WRAPPER)('%s is on the wrapper', (name) => {
    expect(source(name)).toMatch(usesWrapper);
  });

  it.each(NOT_YET)('%s is not on the wrapper yet (move it to ON_WRAPPER once it is)', (name) => {
    expect(source(name)).not.toMatch(usesWrapper);
  });

  // The wrapper owns these, so a function on it that also does one by hand has two answers to
  // the same question, and the hand-written one is the one nobody checks.
  it.each(ON_WRAPPER)('%s leaves the preamble to the wrapper', (name) => {
    const text = source(name);
    expect(text).not.toMatch(/buildAccountCorsHeaders|buildCorsHeaders|buildPublicCorsHeaders|Access-Control-Allow-/);
    expect(text).not.toMatch(/authenticateBearer|authenticateAdmin|resolveAccountRequest|sessionMissingSecondFactor|auth\.getUser/);
    expect(text).not.toMatch(/checkRateLimit\(/);
    expect(text).not.toMatch(/httpMethod/);
    expect(text).not.toMatch(/JSON\.parse\(event\.body/);
  });

  it('the list still to move has not grown', () => {
    // 63 on 2026-11-16, when the wrapper was introduced with its first twelve. Lower this number
    // as functions move; it never goes up.
    expect(NOT_YET.length).toBeLessThanOrEqual(63);
  });
});

describe('api/functions/http/ is not deployed as a function', () => {
  // Netlify deploys a subfolder as a function when it holds index.* or a file named after the
  // folder (the same rule that keeps api/functions/db/ a plain folder of helpers).
  it.each(['index.ts', 'index.js', 'http.ts', 'http.js'])('holds no %s', (name) => {
    expect(existsSync(join(functionsDir, 'http', name))).toBe(false);
  });
});
