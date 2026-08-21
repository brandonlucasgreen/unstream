# Sparkle updates (Mac app)

The Mac app updates itself with [Sparkle 2](https://sparkle-project.org). Before this, the app
could only *tell* somebody an update existed and then send them to GitHub to download a DMG and
drag it over their own install — so in practice most people stayed on whatever version they first
installed. Sparkle downloads, verifies, installs and relaunches.

The iOS app is unaffected: it ships through the App Store, and Sparkle is macOS-only (the
dependency is filtered to macOS in `project.yml`).

## How it fits together

| Piece | Where |
|---|---|
| Sparkle dependency (2.9.6, SPM binary framework) | `apps/mac/project.yml` → `packages:` |
| The updater, gentle reminders, settings migration | `apps/mac/Unstream/Platform/macOS/SparkleUpdater.swift` |
| Feed URL, public key, sandbox switch | `apps/mac/Unstream/Info-macOS.plist` (`SU*` keys) |
| Sandbox permission for Sparkle's installer | `apps/mac/Unstream/Unstream-macOS.entitlements` |
| Settings ▸ About ▸ Updates | `apps/mac/Unstream/Views/macOS/SettingsView.swift` |
| The appcast itself | `api/shared/desktop-release.ts` + `api/functions/desktop-appcast.ts` |
| Its public URL | `https://unstream.stream/appcast.xml` (routed in `netlify.toml`) |

Three settings are load-bearing together, and changing one without the others produces an update
that **downloads successfully and then fails to install** — the worst failure shape, because it
looks like it worked:

1. `SUEnableInstallerLauncherService` = `YES` in `Info-macOS.plist`
2. `com.apple.security.temporary-exception.mach-lookup.global-name` listing
   `$(PRODUCT_BUNDLE_IDENTIFIER)-spks` and `-spki` in the entitlements
3. The app staying sandboxed (`com.apple.security.app-sandbox`)

There is no Downloader XPC service: the app already has `com.apple.security.network.client`, and
Sparkle's docs say not to enable both.

## The signing keys

Updates are signed with an EdDSA (ed25519) key pair, separate from the Developer ID certificate.

- **Public key** — `SUPublicEDKey` in `Info-macOS.plist`. Baked into every shipped build.
- **Private key** — generated 2026-08-21, stored in the **login keychain** on Brandon's Mac as
  *"Private key for signing Sparkle updates"*. It is not in the repo and must never be.

**Back the private key up somewhere safe.** If it's lost, no future release can be signed with it,
and every already-installed copy of the app will reject updates signed with a new key — those
people would have to download a fresh DMG by hand, which is the situation Sparkle was adopted to
end. Export it with:

```bash
./bin/generate_keys -x sparkle-private-key.txt
```

(from an unpacked Sparkle distribution; store the file in the Brain vault alongside the App Store
Connect key, then delete the local copy). To restore it on a new machine:
`./bin/generate_keys -f sparkle-private-key.txt`.

## Releasing an update

This is the existing archive → DMG → notarize → staple release process with two steps added at
the end. Nothing before step 6 changes.

1. **Bump the version in three places** — `Info-macOS.plist`, `Info-iOS.plist`, and the share
   extension block in `project.yml`. Then `xcodegen generate`.

   **`CFBundleVersion` must increase.** Sparkle compares the appcast's `sparkle:version` against
   the installed app's `CFBundleVersion`, *not* the marketing version. A release that bumps
   `3.5.0` → `3.6.0` while leaving `CFBundleVersion` at `15` is invisible to Sparkle.
2. Archive and export with Developer ID (`archive` + `-exportArchive`, hardened runtime on).
   This is also what re-signs Sparkle's XPC services and helpers and strips their
   `get-task-allow` — a hand-rolled `codesign --deep` does not, and is the usual cause of
   sandbox errors. Do not add `--deep`.
3. `create-dmg` as before.
4. `xcrun notarytool submit` the DMG.
5. `xcrun stapler staple` the DMG.
6. **Sign the DMG for Sparkle.** From an unpacked Sparkle distribution:

   ```bash
   ./bin/sign_update /path/to/build/Unstream-3.6.0.dmg
   ```

   It prints the two values the appcast needs:

   ```
   sparkle:edSignature="…" length="12345678"
   ```

   Note the DMG must be final — signature and length cover the exact bytes people download, so
   re-stapling or rebuilding it after this point invalidates both.
7. **Update `api/shared/desktop-release.ts`** with `shortVersion`, `build`, `url`, `lengthBytes`,
   `edSignature`, `publishedAt` and `releaseNotes`, and merge it. Until that's deployed the
   release exists on GitHub but nobody's app knows about it.
8. Publish the GitHub release with the DMG attached at the URL named in step 7.

`api/shared/desktop-release.ts` also feeds `/api/desktop/version`, the pre-Sparkle check that
versions up to 3.5.0 still poll — so one edit covers both old and new installs. Those older
versions will keep notifying and linking to GitHub; they get Sparkle once they've been updated by
hand one final time.

An entry with an empty `edSignature` or a zero `lengthBytes` is deliberately **omitted** from the
appcast rather than published unsigned — an unsigned item is rejected by every client and reads to
the user as "no update available".

## Verifying before you publish

```bash
curl -s https://unstream.stream/appcast.xml
```

Check the `sparkle:version` matches the new `CFBundleVersion`, and that `length` matches the DMG
(`stat -f%z Unstream-3.6.0.dmg`).

To exercise a check immediately instead of waiting for the daily schedule, reset Sparkle's
timestamp before launching the app:

```bash
defaults delete lol.bgreen.Unstream SULastCheckTime
```

Sparkle's own settings live in the same domain — `SUEnableAutomaticChecks`,
`SUAutomaticallyUpdate`, `SULastCheckTime`, `SUSkippedVersion`. Deleting `SUSkippedVersion` undoes
a "Skip this version" click.

## Behaviour in a menu bar app

Unstream has no window and no Dock icon, so Sparkle's default "show an update alert" would belong
to an app the person can't see or command-tab to. `SparkleUpdater` implements Sparkle's gentle
reminders instead: a *scheduled* update briefly gives the app a Dock icon with a badge and, only
if notifications are already authorized, posts a notification that opens Sparkle's alert. The Dock
icon goes away again when the update session ends. User-initiated checks (Settings ▸ About ▸ Check
for Updates…) always show Sparkle's UI directly.

It deliberately never *asks* for notification permission — the Dock badge carries the reminder on
its own, and prompting somebody for notifications in order to mention an update is a bad trade.

## What was removed

`UpdateChecker.swift` is gone, along with the `checkForUpdatesAutomatically` preference and the
Settings pane's hand-rendered status line and "Download Update" link. Somebody who had explicitly
switched automatic checks *off* keeps that choice: `SparkleUpdater.migrateLegacyAutomaticCheckSetting()`
carries an explicit `false` over to Sparkle once, then deletes the old key.
