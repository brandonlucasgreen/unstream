# apps/mac/ — the Apple app

Read this with the root `CLAUDE.md`. Pushes that touch only `apps/mac/` do not deploy the website. The Apple app has XCTest coverage in `apps/mac/UnstreamTests/`, run by `mac-build.yml` on changes under `apps/mac/`.

**`apps/mac/`** — universal Apple app (macOS menu bar + iOS), SwiftUI. **`project.yml` is the XcodeGen definition and the source of truth for targets — edit it, not the `.xcodeproj`.**

## Mac app updates (Sparkle)

The Mac app ships as a direct GitHub release and updates itself with Sparkle 2 (SPM, filtered to macOS in `project.yml`). `api/shared/desktop-release.ts` is the single source of truth for the current release; `desktop-appcast.ts` renders it at `/appcast.xml`, and the legacy `/api/desktop/version` endpoint reads the same constant for installs older than 3.6.0. Two traps — detail in `apps/mac/docs/sparkle-updates.md`:

- **Sparkle compares `CFBundleVersion`, not the marketing version.** An appcast whose `sparkle:version` is `3.6.0` against an installed `CFBundleVersion` of `15` offers no update. Bump the build number on every release.
- **The sandbox needs three things at once**: `SUEnableInstallerLauncherService` in `Info-macOS.plist`, the `-spks`/`-spki` `mach-lookup` entitlement exceptions, and the app staying sandboxed. Break one and updates download fine then fail to install — which reads as success right up to the last step. The Developer ID `archive` + `-exportArchive` path also re-signs Sparkle's XPC helpers; don't hand-roll `codesign --deep`.

## Copies of shared logic

The app cannot import the TypeScript in `api/shared/`, so it keeps its own copies. A fix here reaches users only with the app's next release.

| Copy here | Original | Full rule | Pinned by |
|---|---|---|---|
| The Bandcamp-account check in `Unstream/UnstreamAPI.swift` | `api/shared/bandcamp-identity.ts` | `api/functions/CLAUDE.md`, "Search flow" | `UnstreamTests/BandcampIdentityTests.swift` |
| `Unstream/Models/PlatformCatalog.swift` | `api/shared/platform-registry.ts` | `api/CLAUDE.md`, "Platform registry" | `platform-registry-copies.test.ts` |

## What the backend expects of the app

All of these are written up in `api/functions/CLAUDE.md`:

- The app calls search Phase 2 only when Phase 1 answers `hasPendingEnrichment` ("Search flow").
- Saved artists sync through `saved-artists-sync.ts`, and the app cannot answer a two-step challenge, so the fan endpoints it calls still accept a first-factor session ("Auth on the server").
- The Apple Music library scan goes to `me-listening.ts` ("Listening signals"). ListenBrainz scrobbling is in the app only; the backend has no ListenBrainz code.
- A now-playing lookup is reported as `search_kind: now_playing`, and as the `streaming` metric for a claimed artist ("Admin tools", "Artist analytics").
