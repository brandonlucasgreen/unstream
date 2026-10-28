// Paths the service worker must let through to the network on a browser navigation.
//
// Workbox's NavigationRoute answers every navigation with the cached SPA shell unless the path is
// listed here, whatever the server would have said. A returning visitor never reaches the server
// at all, which is invisible to curl and to a fresh browser — so every entry below was found by
// someone who already had the worker installed. Kept out of vite.config.ts so a test can check it
// (tests/unit/pwa-navigate-denylist.test.ts).
export const navigateFallbackDenylist: RegExp[] = [
  // Edge function routes that serve static HTML — don't let SW intercept them.
  // Must stay in sync with the [[edge_functions]] list in netlify.toml: anything
  // missing here gets served the cached SPA shell for returning visitors, so the
  // edge function silently never runs and the SPA re-fetches the data client-side.
  // That is invisible to curl and to a fresh browser, which is what made it hard
  // to spot — /u/* was missing and cost the page ~5s for anyone with the SW installed.
  /^\/a\//,
  /^\/artist\//,
  /^\/u\//,
  // Not an edge function any more: /guides and /guides/* are 301s in netlify.toml since the
  // section was retired (2026-09-27). They stay here so a returning visitor's worker lets
  // the request through to the redirect instead of serving the cached shell, which would
  // render a blank page because no SPA route matches.
  /^\/guides(\/|$)/,
  /^\/search/,
  // Release feeds (.ics/.xml) are served by a Netlify function, not the SPA. Calendar
  // clients never touch the SW, but a user clicking their own feed link in the browser
  // is a navigation, and the cached shell would hand them an HTML page instead of the
  // calendar. /a/ and /u/ above already cover the two public feed shapes.
  /^\/feed\//,
  // Static RSS feeds copied straight from apps/web/public/ (generate-changelog-feed.ts, and
  // guides.xml, frozen since the guides were retired) — not edge functions, but the same
  // navigateFallback trap: NavigationRoute's default allowlist (`[/./]`) matches every
  // browser navigation regardless of file extension, so a returning visitor clicking these
  // RSS links got the cached SPA shell instead of the feed — a blank page, since no route
  // renders for /guides.xml. /^\/guides(\/|$)/ above doesn't match this sibling file.
  /^\/guides\.xml$/,
  /^\/changelog\.xml$/,
  // The API is never the SPA, and a few of its URLs are navigations: Buffer's OAuth redirect
  // lands on /api/me/buffer/callback. Without this the worker answered it with the shell, which
  // rendered "Page not found" — the code was never redeemed and the curator was never connected,
  // while the same URL worked from curl (2026-10-28).
  /^\/api\//,
];
