# apps/extension/ — the browser extension

Read this with the root `CLAUDE.md`. Pushes that touch only `apps/extension/` do not deploy the website.

**`apps/extension/`** — MV3 extension, one content script per streaming site, two manifests.

The extension has no build step: it is plain ES modules loaded from disk, so it cannot import from `api/shared/`. It keeps its own copies instead, and a fix here reaches users only with the extension's next store release. `npm run package:extension` builds the store zips; bump the version in both manifests first.

| Copy here | Original | Full rule | Pinned by |
|---|---|---|---|
| `lib/bandcamp-identity.js` | `api/shared/bandcamp-identity.ts` | `api/functions/CLAUDE.md`, "Search flow" | `bandcamp-identity-copies.test.ts` |
| `lib/constants.js` (platform table) | `api/shared/platform-registry.ts` | `api/CLAUDE.md`, "Platform registry" | `platform-registry-copies.test.ts` |
| `lib/release-display.js` | `api/shared/release-display.ts` | `api/functions/CLAUDE.md`, "Release dedup" | `extension-release-display.test.ts` |

## What the backend expects of the extension

All of these are written up in `api/functions/CLAUDE.md`:

- The extension calls search Phase 2 only when Phase 1 answers `hasPendingEnrichment` ("Search flow").
- A now-playing search is counted once per listening stretch with an artist (`lib/search-tracking.js`), and reported as the `streaming` metric for a claimed artist ("Admin tools", "Artist analytics").
- The popup calls `saved-artists` and `saved-artists-sync`, which echo the extension's own origin in their CORS headers ("API middleware & security").
- The extension cannot answer a two-step challenge, so the fan endpoints it calls still accept a first-factor session ("Auth on the server").
