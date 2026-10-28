// The service worker's navigation denylist. A path missing from it is answered with the cached
// SPA shell for anyone who has the worker installed, and only for them — so this is the one place
// the gap can be caught before a returning visitor finds it.
import { describe, it, expect } from 'vitest';
import { navigateFallbackDenylist } from '../../pwa-navigate-denylist';

const passesThrough = (path: string) => navigateFallbackDenylist.some(re => re.test(path));

describe('service worker navigate fallback', () => {
  it.each([
    // Buffer's OAuth redirect: the shell rendered "Page not found" and the code was never redeemed.
    '/api/me/buffer/callback',
    '/api/curator/preview',
    '/a/kid-lightbulbs',
    '/a/kid-lightbulbs/some-release',
    '/artist/kid-lightbulbs',
    '/u/brandon',
    '/search',
    '/feed/f/token.ics',
    '/guides',
    '/guides.xml',
    '/changelog.xml',
  ])('lets %s through to the network', path => {
    expect(passesThrough(path)).toBe(true);
  });

  it.each(['/', '/curator/new', '/my-collection', '/settings', '/my-artists', '/claim/kid-lightbulbs'])(
    'serves the app shell for %s',
    path => {
      expect(passesThrough(path)).toBe(false);
    },
  );
});
