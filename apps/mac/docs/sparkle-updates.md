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
  *"Private key for signing Sparkle updates"* (service `https://sparkle-project.org`, account
  `ed25519`). It is not in the repo and must never be.

**The tools live at `~/Developer/sparkle-2.9.6/bin/`** — `generate_keys`, `sign_update`,
`generate_appcast`. They ship inside `Sparkle-for-Swift-Package-Manager.zip` but SPM doesn't put
them anywhere findable, so they were copied out by hand. Every command below assumes that path.

### The key does NOT sync to iCloud

Sparkle stores it as a **non-synchronizable** login-keychain item, so it does not appear in the
Passwords app and is not in iCloud Keychain. It exists on exactly one Mac. Lose that Mac and no
future release can be signed with it — and every already-installed copy of the app rejects updates
signed with a replacement key, leaving those people to download a DMG by hand forever. That's the
situation Sparkle was adopted to end, so this backup is not optional.

Check whether it's still the right key before any release — one read-only command, no prompt:

```bash
~/Developer/sparkle-2.9.6/bin/generate_keys -p
/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' apps/mac/Unstream/Info-macOS.plist
```

Those two must print the same string. If they ever diverge, every signature is rejected and it
looks to users like "no update available".

### Backing it up into the Passwords app

```bash
~/Developer/sparkle-2.9.6/bin/generate_keys -x ~/Desktop/sparkle-private-key.txt
```

macOS will ask permission for the tool to read the key — click **Allow**. Then:

1. Open `~/Desktop/sparkle-private-key.txt` and copy the long key string out of it.
2. Passwords app → **+ New Password**. Title it something findable, e.g. *Unstream — Sparkle
   update signing key*. Paste the key into the **Password** field. Save.
3. Delete `~/Desktop/sparkle-private-key.txt`.

To restore it onto a new Mac: copy the string back into a file and run
`generate_keys -f thatfile`.

Alternative, matching what's already done with the App Store Connect `.p8`: keep the exported file
in the Brain vault next to `AuthKey_XDBZJJA474.p8`. Less protected than the Passwords app (iCloud
Drive holds it as plain text) but consistent with the existing habit, and it's a file rather than
a copy-paste.

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
6. **Sign the DMG for Sparkle:**

   ```bash
   ~/Developer/sparkle-2.9.6/bin/sign_update /path/to/build/Unstream-3.6.0.dmg
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

A dockless accessory app *can* put up an update alert — it can activate and show a key window
with no Dock icon and no pre-existing window. What it can't do is let Sparkle choose the moment.
Sparkle's two scheduled paths both go wrong here:

- **With immediate focus** it shows a modal straight away. For an app that launches at login,
  that means a window in front of whatever you're doing, seconds after you sit down.
- **Without it**, the docs say a dockless app's alert is *"presented behind other apps and
  windows"* — and an accessory app has no Dock icon and no Command-Tab entry, so there's nothing
  to click to bring it back. It's effectively invisible.

So `SparkleUpdater` returns `false` from `standardUserDriverShouldHandleShowingScheduledUpdate`
and announces the update itself: an "Install Unstream X.Y.Z" row appears at the top of the
popover, above the tabs and above any drill-down so it can't be buried. Clicking it calls
`checkForUpdates()`, which is how Sparkle's docs say to pull an already-prepared update into
focus; the alert then appears with its release notes and Install button. The row clears when the
user gives the alert attention or the session ends.

A notification is posted alongside it, but **only if authorization already exists** — this
deliberately never prompts for notification permission just to mention an update. The popover row
is the actual channel; the notification is a nudge for people who aren't looking at the menu bar.

**While an alert is up, the app takes a Dock icon** (`.regular`), and goes back to `.accessory`
when the session ends. This is the one piece a menu bar app can't skip, and it's what CleanShot X,
Ice and Reminders MenuBar all do. The reason is `standardUserDriverDidReceiveUserAttention`: it
fires when the alert is merely *focused*, not only when it's acted on, so the popover row is gone
by then. Without a Dock icon, somebody who clicks the row and then switches to their browser
mid-decision has an alert sitting behind everything, absent from both the Dock and the app
switcher, with no route back to it. It's applied to user-initiated checks too, so "where did that
window go" has one answer rather than two.

**No Dock badge**, though — of the LSUIElement + Sparkle apps surveyed on this Mac, three
implement gentle reminders and none badges the Dock. An earlier draft did; it read as shouting for
a menu bar utility.

## What was removed

`UpdateChecker.swift` is gone, along with the `checkForUpdatesAutomatically` preference and the
Settings pane's hand-rendered status line and "Download Update" link. Somebody who had explicitly
switched automatic checks *off* keeps that choice: `SparkleUpdater.migrateLegacyAutomaticCheckSetting()`
carries an explicit `false` over to Sparkle once, then deletes the old key.
