# Unstream Universal Apple App - Test Plan

Version 3.0.0 | Last updated 2026-03-29

> **Architecture note:** This is a universal Apple app using `#if os()` conditionals in shared code. There is no separate `Platform/iOS/` directory -- platform-specific behavior is handled inline. macOS-specific code lives in `Platform/macOS/`, `Views/macOS/`, and iOS-specific views live in `Views/iOS/`.

This test plan covers the universal Apple app (macOS + iOS) built from a single multiplatform target. Tests are prioritized P0 (must-pass before any release), P1 (should-pass before public release), and P2 (nice-to-verify, lower risk).

---

## Prerequisites

- Xcode 16+ with iOS 17+ and macOS 13+ simulators
- Apple Developer account with App Groups (`group.lol.bgreen.unstream`) provisioned
- StoreKit Configuration file for tip jar IAPs (`lol.bgreen.unstream.tip.small/medium/large`)
- Network access to `unstream.stream` API
- Test devices: iPhone (physical preferred), iPad, Mac (Apple Silicon)
- Music apps installed: Apple Music, Spotify (macOS); any streaming app (iOS for share extension)

---

## P0 - Critical Path (must-pass)

### Build & Launch

- [ ] **macOS**: `xcodegen generate` succeeds in `apps/mac/` without errors
- [ ] **macOS**: Project builds for macOS destination in Xcode (Release config)
- [ ] **iOS**: Project builds for iOS destination in Xcode (Release config)
- [ ] **macOS**: App launches as menu bar-only (no Dock icon, no main window)
- [ ] **macOS**: Menu bar icon appears and is visible in both light/dark menu bar
- [ ] **iOS**: App launches and shows tab bar with Search, Saved, Releases, Settings
- [ ] **Share Extension**: `UnstreamShareExtension` target builds for iOS without errors

### Search - Core Flow

- [ ] **macOS**: Click menu bar icon opens popover with search bar
- [ ] **macOS**: Type artist name, press Enter, results appear with platform badges
- [ ] **macOS**: Results show verified platforms, social platforms, and "Also try" sections correctly
- [ ] **iOS**: Search tab shows `.searchable` bar; type artist name, submit, results appear
- [ ] **iOS**: Results show platform badges with correct colors and icons
- [ ] **Both**: Two-phase search works -- initial results appear, then MusicBrainz enrichment adds official site/Discogs/social links
- [ ] **Both**: "Open in browser" button opens `unstream.stream/?q=<artist>` in default browser
- [ ] **Both**: API errors show error state (not a crash), with retry path (search again)
- [ ] **Both**: Empty search query does not trigger API call
- [ ] **Both**: Artist photo loads via AsyncImage when `imageUrl` is present

### Saved Artists

- [ ] **Both**: Tapping heart icon on search result saves artist (heart fills red)
- [ ] **Both**: Tapping filled heart removes artist from saved list
- [ ] **Both**: Saved artists persist across app relaunch (UserDefaults + iCloud KVS)
- [ ] **macOS**: Popover "Saved Artists" tab shows all saved entries with platform badges
- [ ] **iOS**: "Saved" tab shows saved artists in NavigationStack with platform links
- [ ] **Both**: Platform badges in saved list are tappable and open correct URLs
- [ ] **Both**: Refresh button on saved entry re-fetches platforms from API

### Release Alerts

- [ ] **Both**: Toggle "Release Alerts" on in settings enables weekly checking
- [ ] **Both**: "Check Now" button triggers immediate release check for all saved artists
- [ ] **Both**: New releases appear in the releases list with artist name, release name, platform
- [ ] **Both**: Tapping a release row/badge opens the release URL in browser
- [ ] **macOS**: Release notifications appear as system notifications with release details
- [ ] **macOS**: Clicking notification opens the release URL
- [ ] **iOS**: Releases tab shows empty state when no releases, with appropriate messaging based on alerts enabled/disabled

---

## P1 - Important Functionality

### macOS - Now Playing Detection (macOS only -- no playback detection on iOS)

- [ ] Play music in Apple Music; popover auto-detects artist, album, track
- [ ] Play music in Spotify; popover auto-detects artist, album, track
- [ ] Artist change triggers API search and updates results
- [ ] Album artwork displays in NowPlayingView when available
- [ ] Debouncing works: same artist within 30 seconds does not re-fetch
- [ ] Stop playback clears now playing state (shows empty state or prior search)
- [ ] Manual search overrides now playing display; clearing search returns to now playing
- [ ] `musicListeningEnabled` toggle in settings disables/enables MediaObserver

### macOS - Menu Bar & Popover

- [ ] Clicking outside popover closes it (transient behavior)
- [ ] Clicking menu bar icon toggles popover open/closed
- [ ] Popover tab switching between Search and Saved Artists works
- [ ] Saved Artists tab badge shows count when > 0
- [ ] Footer menu (ellipsis) shows Settings, Roadmap, Feedback, Support, Quit
- [ ] "Quit" terminates the app
- [ ] Cmd+, opens Settings window
- [ ] Settings window appears centered, with General/Integrations/About tabs

### macOS - Settings

- [ ] **General**: "Music app listening" toggle persists via @AppStorage
- [ ] **General**: "Start at login" toggle registers/unregisters SMAppService
- [ ] **General**: Keyboard shortcut recording captures modifier+key combo
- [ ] **General**: Recorded shortcut displays correctly (e.g., "Ctrl+Shift+U")
- [ ] **General**: Global hotkey opens popover from any app when enabled
- [ ] **General**: "Clear" removes shortcut; "Change" allows re-recording
- [ ] **Integrations**: Release alerts section shows last check date and check now button
- [ ] **Integrations**: ListenBrainz token validation succeeds with valid token, shows username
- [ ] **Integrations**: ListenBrainz invalid token shows error, clears stored token
- [ ] **Integrations**: "Disconnect" clears token and disables scrobbling
- [ ] **About**: "Check for Updates…" opens Sparkle's own alert (an update, or "you're up to date")
- [ ] **About**: both update toggles persist across a relaunch; the second is disabled while the first is off
- [ ] **About**: Version number matches CFBundleShortVersionString (3.0.0)
- [ ] **About**: Links to unstream.stream open in browser

### macOS - Scrobbling (macOS only -- out of scope for iOS)

- [ ] With ListenBrainz enabled and valid token, playing a track submits a listen
- [ ] Scrobble count increments in settings after submission
- [ ] Scrobbling disabled when toggle is off, even with valid token

### macOS - Welcome Window

- [ ] First launch (no `hasLaunchedBefore` UserDefault) shows welcome window
- [ ] Welcome window explains menu bar usage and music detection
- [ ] "Got it!" button dismisses window, sets `hasLaunchedBefore`, enables launch at login
- [ ] Subsequent launches do not show welcome window

### iOS - Tab Navigation

- [ ] All four tabs (Search, Saved, Releases, Settings) are reachable
- [ ] Tab icons and labels match: magnifyingglass, heart.fill, sparkles, gearshape
- [ ] NavigationStack titles show correctly: "Unstream", "Saved Artists", "Releases", "Settings"
- [ ] Back navigation works within each tab's NavigationStack

### iOS - Settings

- [ ] Release Alerts toggle persists via UserDefaults
- [ ] Last check date displays in relative format when available
- [ ] Tip Jar section loads StoreKit products
- [ ] Version number displays correctly
- [ ] Links (Website, Source Code, Feedback) open in Safari

### iOS - Share Extension

- [ ] Share a Bandcamp URL (e.g., `artist.bandcamp.com`) from Safari; extension extracts artist name
- [ ] Share an Apple Music artist URL; extension extracts artist name from path
- [ ] Share a SoundCloud URL; extension extracts artist name
- [ ] Share a Mirlo URL; extension extracts artist name
- [ ] After sharing, main app opens with the extracted query pre-filled
- [ ] Pending search is read from App Group UserDefaults on app appear
- [ ] Extension gracefully handles unsupported URLs (Spotify, YouTube Music, Tidal) by passing raw URL

### iOS - Deep Links

- [ ] `unstream://search?q=Radiohead` opens app and triggers search for "Radiohead"
- [ ] Deep link with empty or missing `q` parameter does not crash
- [ ] Deep link with URL-encoded special characters decodes correctly

### Tip Jar (StoreKit 2)

- [ ] Products load and display sorted by price (small < medium < large)
- [ ] Tapping a tip triggers purchase flow
- [ ] Successful purchase shows thank-you state, then resets
- [ ] User cancellation returns to idle state
- [ ] Failed purchase shows error message, then resets
- [ ] Products display correct prices from App Store Connect (or StoreKit config)

### Cross-Platform Data Sync

- [ ] Save artist on macOS; appears on iOS after iCloud KVS sync
- [ ] Save artist on iOS; appears on macOS after iCloud KVS sync
- [ ] Delete artist on one platform; deletion syncs to other
- [ ] iCloud KVS observer fires on external change notification

---

## P2 - Polish & Edge Cases

### UI/UX - Dark Mode & Theming

- [ ] **macOS**: Popover looks correct in dark mode (card backgrounds, text contrast)
- [ ] **macOS**: Popover looks correct in light mode
- [ ] **macOS**: Settings window respects system appearance
- [ ] **iOS**: All tabs look correct in dark mode
- [ ] **iOS**: All tabs look correct in light mode
- [ ] **Both**: Platform badge colors have sufficient contrast in both modes
- [ ] **Both**: Social icon buttons visible in both modes (white in dark, colored in light)

### UI/UX - Dynamic Type & Accessibility

- [ ] **iOS**: Increase text size to largest accessibility size; layouts remain usable
- [ ] **iOS**: VoiceOver can navigate Search tab, read results, activate badges
- [ ] **iOS**: VoiceOver announces tab names correctly
- [ ] **macOS**: VoiceOver can navigate popover, read results, activate buttons
- [ ] **Both**: FlowLayout wraps platform badges correctly at narrow widths
- [ ] **Both**: All interactive elements have sufficient tap/click targets

### iPad

- [ ] App runs on iPad with correct layout (tab bar, navigation)
- [ ] All four orientations work per UISupportedInterfaceOrientations~ipad (including upside-down portrait)
- [ ] Search results use available width well (no overly compressed or stretched layouts)
- [ ] Share extension works on iPad

### Edge Cases - Network

- [ ] **Both**: Search with no internet shows error state, not crash
- [ ] **Both**: API timeout (>10s) shows error state
- [ ] **Both**: Release check with no internet fails silently (no user-facing error)
- [ ] **Both**: Airplane mode during tip purchase handles gracefully

### Edge Cases - Empty States

- [ ] **macOS**: Popover with no music playing and no search shows EmptyStateView
- [ ] **iOS**: Search tab empty state shows music.note.house icon and prompt
- [ ] **iOS**: Saved tab with no artists shows "No artists saved yet" with instructions
- [ ] **iOS**: Releases tab with alerts off shows "Enable release alerts in Settings" prompt
- [ ] **iOS**: Releases tab with alerts on but no releases shows "No new releases" with last check date
- [ ] **Both**: Bandcamp Friday indicator appears on Bandcamp Friday dates (test with mocked date if needed)
- [ ] **Both**: Search results with zero platforms shows "No results found"

### Edge Cases - Content

- [ ] Search for artist with special characters (e.g., "Bjork", "Sunn O)))") returns results
- [ ] Search for very long artist name does not crash or truncate search
- [ ] Artist with no imageUrl shows person.circle.fill placeholder
- [ ] Artist photo that fails to load shows fallback icon
- [ ] Share text includes now-playing context when sharing artist currently playing (macOS)
- [ ] Report issue button opens email compose with pre-filled details

### Edge Cases - State

- [ ] **macOS**: Rapid popover open/close does not create duplicate status items
- [ ] **macOS**: `applicationShouldHandleReopen` returns false (no duplicate windows)
- [ ] **macOS**: Multiple calls to AppDelegate do not create multiple status items (static guard)
- [ ] **Both**: Rapid search submissions debounce correctly (only latest query resolves)
- [ ] **Both**: Switching between search and saved list does not lose search state
- [ ] **iOS**: Backgrounding and foregrounding app does not reset search results

### Entitlements & Sandbox

- [ ] **macOS**: App sandbox enabled with network client permission
- [ ] **macOS**: Scripting targets allow Apple Music and Spotify automation
- [ ] **macOS**: Temporary exception for Parachord Apple Events works
- [ ] **macOS**: App Groups entitlement matches share extension
- [ ] **macOS**: iCloud KVS identifier resolves correctly with team prefix
- [ ] **iOS**: Share extension has App Groups entitlement for `group.lol.bgreen.unstream`

---

## Build & Distribution

### macOS

- [ ] Archive builds successfully for macOS
- [ ] Notarization succeeds (if distributing outside Mac App Store)
- [ ] DMG packaging works with `dmg_background.png`
- [ ] App opens correctly after download from notarized DMG
- [ ] Mac App Store archive builds with correct entitlements (if targeting MAS)

### iOS

- [ ] Archive builds successfully for iOS (including share extension)
- [ ] TestFlight upload succeeds
- [ ] App installs and launches on physical device from TestFlight
- [ ] Share extension appears in iOS share sheet from Safari
- [ ] App review metadata: privacy labels, screenshots, description ready

### Universal

- [ ] Bundle ID is `lol.bgreen.Unstream` (not old `UnstreamMenubar`)
- [ ] Version is 3.0.0, build number is 3
- [ ] `destinationFilters` correctly exclude macOS-only code from iOS and vice versa
- [ ] No `#if os()` compilation errors on either platform
- [ ] ExportOptions.plist is configured for intended distribution method

---

## Known Gaps & Notes

1. **No playback detection on iOS**: Per the spec, iOS v1 does not include playback detection. The `NowPlaying` model and `MediaObserver` are macOS-only. Scrobbling (ListenBrainz/Last.fm) and Radiccio detection are also macOS-only. This is intentional.

2. **Radiccio NSDistributedNotificationCenter**: The memory file notes this is not yet implemented in MediaObserver. Currently using temporary Apple Events exception for Parachord. Low priority for initial release but worth tracking.

3. **ScrobbleManager retry TODO**: There is a `// TODO: Queue for retry` in ScrobbleManager.swift (line 181). Failed scrobbles are currently dropped.

4. **Brand icons on iOS**: `BrandIcons.swift` is in `Views/Shared/` and available on both platforms. However, `SavedPlatformBadge` in `SupportListView.swift` currently uses `#if os(macOS)` to render SVG brand icons on macOS and falls back to SF Symbols on iOS. The shared `BrandIcon` view could be used on iOS too in a future update to unify the look.

5. **DEVELOPMENT_TEAM is empty**: `project.yml` has `DEVELOPMENT_TEAM: ""`. This must be set to your team ID before archiving for distribution.
