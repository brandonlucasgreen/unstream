---
status: Idea
---
# Android App Scoping Document

Last updated: 2026-03-29

## Background

Unstream currently has a universal Apple app (macOS menu bar + iOS) built in native SwiftUI. This document scopes what it takes to build and launch an Android equivalent for someone with zero Android development experience but a test device available.

The iOS app has four tabs: Search, Saved Artists, Releases, and Settings. On macOS, it runs as a menu bar popover with now-playing detection (via AppleScript polling of Music.app, Spotify, Radiccio, and Parachord). The iOS version does not have now-playing detection but does have a Share Extension for sharing streaming URLs into Unstream.

---

## 1. Technology Choices

### Option A: Native Kotlin + Jetpack Compose

**Pros:**
- First-class Android experience. Material Design 3 out of the box.
- Best access to platform APIs (MediaSession, notification listeners, widgets, share targets).
- Jetpack Compose is declarative UI, conceptually very similar to SwiftUI. The mental model transfers well.
- Strongest community support, most up-to-date docs, and Android Studio tooling is built for it.
- Google Play review is smoothest with native apps.

**Cons:**
- Another language to learn (Kotlin), though it is approachable and similar to Swift in many ways.
- Zero code sharing with the iOS app. Every screen, model, and service is rewritten.
- You maintain two completely separate native codebases.

### Option B: Kotlin Multiplatform (KMP) + Compose Multiplatform

**Pros:**
- Share business logic (API clients, models, caching) between iOS and Android in Kotlin.
- Compose Multiplatform is reaching stability for iOS (alpha/beta as of early 2026).
- Eventually could replace the SwiftUI iOS app, giving you one codebase.

**Cons:**
- Compose Multiplatform for iOS is still maturing. You would be betting on a moving target.
- The existing iOS app is SwiftUI and works. Rewriting it into Compose Multiplatform is a separate, large project.
- The shared-logic benefit is modest for Unstream because most logic lives server-side (the API does the heavy lifting). The app is mostly UI + API calls + local storage.
- Steeper learning curve: you are learning Kotlin, Compose, AND the multiplatform toolchain simultaneously.

### Option C: React Native

**Pros:**
- You already know React and TypeScript from the web app.
- Could theoretically share some types/interfaces with the web codebase.
- Large ecosystem, mature tooling.

**Cons:**
- Now-playing detection and notification listener access require native modules (Java/Kotlin bridges), which defeats much of the "write once" benefit.
- React Native performance for this kind of app is fine, but the bridge layer adds complexity for platform-specific features.
- You would still not share code with the iOS app (which is SwiftUI).
- Debugging native module issues without Android experience is painful.

### Option D: Flutter

**Pros:**
- Single codebase for both platforms. Could eventually replace the iOS app too.
- Dart is easy to pick up. Hot reload is excellent for iteration.
- Strong widget/UI library.

**Cons:**
- Dart is yet another language with no overlap to your existing stack (TypeScript, Swift).
- Platform API access (MediaSession, notification listeners) requires platform channels — same native bridge problem as React Native.
- Would not share code with the existing web app or iOS app.
- Flutter apps have a slightly non-native feel on Android unless you work hard at Material theming.

### Recommendation: Native Kotlin + Jetpack Compose

For Unstream specifically, native Kotlin is the best path. Here is why:

1. **The app is thin.** Unstream's complexity lives in the server-side search API, not the client. The Android app is essentially: call API, display results, persist a saved list locally, check for new releases via API, detect now-playing music. This is a small surface area — the cost of "rewriting" in Kotlin is low.

2. **Platform APIs matter.** The most compelling Android features (MediaSession now-playing detection, notification listener for detecting what is playing in any app, home screen widgets, share sheet integration) all require native Android APIs. Going through a bridge layer in React Native or Flutter adds complexity without saving much.

3. **SwiftUI-to-Compose transfer is real.** Both are declarative, state-driven UI frameworks. `@Published` maps to `MutableStateFlow`. `@EnvironmentObject` maps to `CompositionLocal` or ViewModel injection. `NavigationStack` maps to `NavHost`. The patterns are different in syntax but identical in concept. You will feel productive faster than you expect.

4. **One clean codebase per platform.** Maintaining a native iOS app and a native Android app is simpler than maintaining a cross-platform app that needs native bridges for the features that matter most.

---

## 2. Feature Parity Assessment

### Features that map 1:1 to Android

| iOS Feature | Android Equivalent | Difficulty |
|---|---|---|
| Artist search (API call + results display) | Identical — call same API, render in Compose | Easy |
| Search results grouped by category (purchase, streaming, social) | Identical UI pattern in Compose | Easy |
| Platform badges with payout percentages | Identical | Easy |
| Saved Artists list (local persistence) | Room database or DataStore | Easy |
| Release alerts (API-driven, check saved artists) | Identical — same API endpoint | Easy |
| Settings screen | Identical | Easy |
| Deep linking (unstream:// URL scheme) | Android App Links / deep links | Easy |
| Share Extension (receive shared URLs) | Share target / intent filter | Easy |
| Open platform links in browser | Identical | Easy |

### Features that work differently on Android

| iOS Feature | Android Difference | Notes |
|---|---|---|
| macOS now-playing via AppleScript | Android uses `MediaSession` API or `NotificationListenerService` | **Better on Android.** Android's `NotificationListenerService` can detect what is playing in ANY app (Spotify, YouTube Music, Tidal, etc.) without per-app AppleScript hacks. This is a significant upgrade. Requires user to grant notification access permission. |
| macOS menu bar popover | No direct equivalent | Android does not have a menu bar. The equivalent experience is a home screen widget or a persistent notification with quick actions. |
| macOS global hotkey | No direct equivalent | Not applicable on Android. |
| ListenBrainz scrobbling | Works the same — HTTP POST to ListenBrainz API | Easy, can piggyback on now-playing detection |
| iOS Share Extension (receive URLs) | Android share target via intent filter | Slightly different mechanism but same user experience |

### Android-unique opportunities

| Feature | Description | Priority |
|---|---|---|
| **Home screen widget** | Show now-playing artist's alternative platforms right on the home screen. Glance widget with Material You theming. | High — this is the killer Android feature |
| **Notification listener now-playing** | Detect music from ANY app via notification listener. Far more powerful than the macOS AppleScript approach. | High — core differentiator |
| **Quick Settings tile** | Add a tile to the notification shade for quick search | Medium |
| **Share target** | Appear in the Android share sheet so users can share a Spotify/Apple Music link and get Unstream results | High |
| **Notification channels** | Separate channels for release alerts vs. now-playing, so users can control each independently | Medium |
| **Material You dynamic color** | App theme adapts to the user's wallpaper colors automatically | Low (nice-to-have) |

### Minimum Viable Feature Set (v1)

1. Artist search with grouped results (calls existing Unstream API)
2. Saved Artists list with local persistence
3. Release alerts for saved artists
4. Now-playing detection via NotificationListenerService
5. Share target (receive links from other apps)
6. Settings screen (notification preferences, about)
7. Deep linking support

What to defer to v2: home screen widget, ListenBrainz scrobbling, Quick Settings tile, Material You dynamic color.

---

## 3. Development Environment Setup

### What to install

1. **Android Studio** (current stable — Meerkat or later). Download from developer.android.com. This is the only IDE you need. It includes:
   - Kotlin compiler
   - Android SDK (will prompt to install on first launch)
   - Android Emulator
   - Gradle build system
   - Layout inspector, profiler, logcat

2. **JDK**: Android Studio bundles one, but if you hit issues, install JDK 17 via Homebrew: `brew install openjdk@17`

3. **Android SDK**: Android Studio will prompt you to install SDK 34 or 35 (API level). Accept the defaults. Also install:
   - Android SDK Build-Tools
   - Android SDK Platform-Tools (includes `adb`)
   - Google Play services (for potential future features)

### Test device setup

1. On your Android device, go to **Settings > About Phone** and tap **Build Number** 7 times to enable Developer Options.
2. Go to **Settings > Developer Options** and enable **USB Debugging**.
3. Connect via USB. Your Mac will need to authorize the connection.
4. Run `adb devices` in terminal to confirm the device appears.
5. In Android Studio, your device will appear in the device dropdown. You can deploy directly to it.

Alternatively, use the built-in emulator for initial development, but always test on the real device for notification listener permissions, share targets, and performance.

### Learning curve estimate

Coming from SwiftUI, the conceptual transfer is strong. Here is what maps:

| SwiftUI | Jetpack Compose |
|---|---|
| `@State` | `remember { mutableStateOf() }` |
| `@Published` / `ObservableObject` | `StateFlow` / `ViewModel` |
| `@EnvironmentObject` | `CompositionLocal` or Hilt injection |
| `VStack`, `HStack`, `ZStack` | `Column`, `Row`, `Box` |
| `NavigationStack` | `NavHost` + `NavController` |
| `List` / `ForEach` | `LazyColumn` / `items()` |
| `.sheet()` / `.fullScreenCover()` | `ModalBottomSheet` / navigation |
| `TabView` | `Scaffold` + `NavigationBar` |
| `UserDefaults` | `DataStore` (Preferences) |
| `Codable` | `kotlinx.serialization` or Gson |

**Estimated ramp-up time:** 1-2 weeks of tutorials and small exercises before you are productive. The official "Android Basics with Compose" course from Google is excellent and free. Budget 10-15 hours for it.

---

## 4. Google Play Store Launch

### Developer account setup

- **Cost:** $25 one-time registration fee (compared to Apple's $99/year).
- **Sign up at:** play.google.com/console
- **Requirements:** Google account, valid payment method, government-issued ID for identity verification.
- **Identity verification:** Google now requires identity verification for all new developer accounts. This takes 2-7 business days. Start this early.
- **Organization vs. Individual:** If you have or plan to get an LLC for Unstream, register as an Organization. Otherwise, Individual is fine for now. You can change later, but it is easier to start correctly.

### App review process

- **First submission:** Typically reviewed within 1-3 days, but can take up to 7 days for new developer accounts. Google's review is generally faster and less opinionated than Apple's.
- **What they check:**
  - Policy compliance (no malware, no deceptive behavior, no prohibited content)
  - Privacy policy presence and accuracy
  - Target audience declaration (Unstream is not directed at children, so you select "general audience")
  - Content rating questionnaire (see below)
  - Permissions justification (you will need to justify NotificationListenerService access)
  - App functionality (they do basic functional testing)
- **Sensitive permissions:** `NotificationListenerService` requires a declaration form explaining why the app needs it. Be clear: "Unstream detects currently-playing music to help users find the artist on alternative platforms. It only reads the artist/title from media notifications and does not access any other notification content." Google has approved this pattern for scrobbling/music-detection apps before.

### Privacy policy requirements

- **Required:** Yes, mandatory for all apps on Google Play.
- **Must cover:** What data you collect (search queries, saved artists, notification content for now-playing), how you use it, whether you share it with third parties, data retention, user rights.
- **Where to host:** Add a page at `unstream.stream/privacy` (you may already have one). Link to it in the Play Console listing AND in the app's settings screen.
- **Data safety section:** Google Play requires a "Data safety" declaration in the Play Console. You fill out a form describing every type of data collected, whether it is shared, whether it is encrypted, and whether users can request deletion. This is separate from the privacy policy but must be consistent with it.

### Content rating questionnaire

- Fill out the IARC (International Age Rating Coalition) questionnaire in the Play Console.
- For Unstream, the answers are straightforward: no violence, no sexual content, no gambling, no user-generated content (the app displays search results, not UGC), no ads.
- You will likely get an **"Everyone"** rating.
- Takes about 5 minutes.

### Listing requirements

| Asset | Specification |
|---|---|
| App name | Up to 30 characters. "Unstream" works. |
| Short description | Up to 80 characters. E.g., "Find your favorite artists on platforms that pay them fairly." |
| Full description | Up to 4000 characters. Describe what the app does, which platforms it searches, the mission. |
| App icon | 512x512 PNG, 32-bit, no transparency |
| Feature graphic | 1024x500 PNG or JPG. Displayed at the top of the listing. |
| Screenshots | Minimum 2, maximum 8 per device type. Phone screenshots must be 16:9 or 9:16 ratio. Recommended: 4-6 screenshots showing search, results, saved artists, release alerts. |
| Phone screenshots | Required |
| Tablet screenshots | Optional but recommended |
| Category | "Music & Audio" |
| Contact email | Required, displayed publicly |
| Privacy policy URL | Required |

### Signing and release process

1. **App signing:** Google manages your app signing key via Play App Signing (opt-in but strongly recommended and now the default). You generate an upload key locally, sign APKs/bundles with it, and Google re-signs with the actual distribution key. This means if you lose your upload key, Google can help you recover. Much better than managing keys yourself.

2. **Build format:** Upload an Android App Bundle (.aab), not an APK. Android Studio generates this with `Build > Generate Signed Bundle`.

3. **Release tracks:**
   - **Internal testing:** Up to 100 testers, no review needed. Use this for early testing.
   - **Closed testing:** Invite-only, reviewed by Google.
   - **Open testing:** Public beta, reviewed by Google.
   - **Production:** Full public release.
   - Recommendation: Start with internal testing, then go straight to production once you are confident. Unstream is low-risk content-wise.

### Update workflow

1. Increment `versionCode` (integer, must increase every release) and `versionName` (human-readable, e.g., "1.1.0") in `build.gradle.kts`.
2. Build a signed .aab.
3. Upload to the Production track in Play Console.
4. Add release notes.
5. Submit for review. Updates are typically reviewed within hours to 1 day.
6. Staged rollout is available (e.g., roll out to 10% of users first, then 100%).

---

## 5. Project Structure

### Directory layout within the monorepo

```
apps/
  android/
    app/
      src/
        main/
          java/lol/bgreen/unstream/
            MainActivity.kt
            UnstreamApp.kt              # Application class
            ui/
              theme/
                Theme.kt                # Material 3 theme, colors, typography
                Color.kt
                Type.kt
              navigation/
                NavGraph.kt             # Navigation routes
              screens/
                search/
                  SearchScreen.kt
                  SearchViewModel.kt
                components/
                  ArtistResultCard.kt
                  PlatformBadge.kt
                  EmptyState.kt
                saved/
                  SavedScreen.kt
                  SavedViewModel.kt
                releases/
                  ReleasesScreen.kt
                  ReleasesViewModel.kt
                settings/
                  SettingsScreen.kt
                  SettingsViewModel.kt
            data/
              api/
                UnstreamApi.kt          # Retrofit/Ktor API interface
                SearchResponse.kt       # API response models
                ReleaseCheckApi.kt
              local/
                SavedArtistDao.kt       # Room DAO
                AppDatabase.kt          # Room database
                SavedArtist.kt          # Room entity
              repository/
                SearchRepository.kt
                SavedArtistRepository.kt
                ReleaseRepository.kt
            model/
              ArtistResult.kt
              PlatformResult.kt
              PlatformConfig.kt
              NowPlaying.kt
              NewRelease.kt
            service/
              NowPlayingService.kt      # NotificationListenerService
              ReleaseCheckWorker.kt     # WorkManager periodic task
            share/
              ShareReceiverActivity.kt  # Handle shared URLs
          res/
            values/
              strings.xml
              themes.xml
            drawable/                   # Platform icons, app icon
            xml/
              backup_rules.xml
        AndroidManifest.xml
      build.gradle.kts                  # App-level build config
    build.gradle.kts                    # Project-level build config
    settings.gradle.kts
    gradle.properties
    gradle/
      libs.versions.toml                # Version catalog
```

### Key dependencies

```toml
# gradle/libs.versions.toml (version catalog)
[versions]
kotlin = "2.1.0"
compose-bom = "2025.03.00"
lifecycle = "2.8.0"
navigation = "2.8.0"
room = "2.7.0"
ktor = "3.0.0"
hilt = "2.52"
coil = "3.0.0"
datastore = "1.1.0"
work = "2.10.0"
serialization = "1.7.0"

[libraries]
# Compose UI
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }
compose-material3 = { group = "androidx.compose.material3", name = "material3" }
compose-ui-tooling = { group = "androidx.compose.ui", name = "ui-tooling" }

# Architecture
lifecycle-viewmodel = { group = "androidx.lifecycle", name = "lifecycle-viewmodel-compose", version.ref = "lifecycle" }
navigation-compose = { group = "androidx.navigation", name = "navigation-compose", version.ref = "navigation" }
hilt-android = { group = "com.google.dagger", name = "hilt-android", version.ref = "hilt" }
hilt-navigation-compose = { group = "androidx.hilt", name = "hilt-navigation-compose", version = "1.2.0" }

# Networking
ktor-client-core = { group = "io.ktor", name = "ktor-client-core", version.ref = "ktor" }
ktor-client-okhttp = { group = "io.ktor", name = "ktor-client-okhttp", version.ref = "ktor" }
ktor-serialization = { group = "io.ktor", name = "ktor-client-content-negotiation", version.ref = "ktor" }
ktor-serialization-json = { group = "io.ktor", name = "ktor-serialization-kotlinx-json", version.ref = "ktor" }

# Local storage
room-runtime = { group = "androidx.room", name = "room-runtime", version.ref = "room" }
room-ktx = { group = "androidx.room", name = "room-ktx", version.ref = "room" }
datastore-preferences = { group = "androidx.datastore", name = "datastore-preferences", version.ref = "datastore" }

# Images
coil-compose = { group = "io.coil-kt.coil3", name = "coil-compose", version.ref = "coil" }

# Background work
work-runtime = { group = "androidx.work", name = "work-runtime-ktx", version.ref = "work" }

# Serialization
kotlinx-serialization = { group = "org.jetbrains.kotlinx", name = "kotlinx-serialization-json", version.ref = "serialization" }
```

**Why these specific libraries:**
- **Ktor** over Retrofit: Kotlin-native HTTP client, cleaner coroutine support, no annotation processing. (Retrofit is also fine — this is a preference call. Ktor is more "Kotlin-idiomatic.")
- **Room** for saved artists: SQLite wrapper with compile-time query verification. Overkill for a simple list, but scales well if you add more local data.
- **Coil** for images: Kotlin-first image loader, Compose integration built-in, lightweight.
- **Hilt** for dependency injection: Standard Android DI. Provides ViewModels, repositories, API clients cleanly.
- **WorkManager** for release checks: Reliable background scheduling that respects battery optimization. Replaces the iOS approach of checking on app foreground.
- **DataStore** for preferences: Modern replacement for SharedPreferences. Type-safe, coroutine-based.

### Sharing logic with the web app

The Android app should call the same Unstream API endpoints the web and iOS apps use:
- `GET https://unstream.stream/.netlify/functions/search-sources?q={query}` — artist search
- `GET https://unstream.stream/.netlify/functions/musicbrainz-search?q={query}` — MusicBrainz enrichment
- `POST https://unstream.stream/.netlify/functions/check-releases` — release checking
- `POST https://unstream.stream/.netlify/functions/track-analytics` — analytics events

No need to share code with the web app. The API is the shared layer. The Android app is a thin client that calls these endpoints, exactly like the iOS app does.

---

## 6. Rough Timeline

These estimates assume you are learning Android as you go, working on this part-time (10-15 hours/week), and using Claude Code to accelerate implementation.

### Phase 1: MVP (6-8 weeks)

| Week | Milestone |
|---|---|
| 1-2 | **Environment + learning.** Install Android Studio. Complete the "Android Basics with Compose" codelab (or enough of it). Get a "hello world" Compose app running on the test device. Set up the project structure within the monorepo. |
| 3-4 | **Search screen.** Implement API client (Ktor). Build SearchScreen with results grouped by category. Platform badges with colors and payout percentages. Loading/error states. This is the core screen. |
| 5 | **Saved Artists + persistence.** Room database for saved artists. SavedScreen with list. Add/remove from search results. |
| 6 | **Release alerts.** WorkManager periodic task to check releases for saved artists. ReleasesScreen. Notification when new release found. |
| 7 | **Settings + polish.** Settings screen. Share target (receive URLs). Deep linking. App icon and theming. |
| 8 | **Testing + Play Store submission.** Test on real device. Fix issues. Prepare listing assets. Submit to Google Play. |

### Phase 2: Feature parity + Android advantages (4-6 weeks after MVP)

| Week | Milestone |
|---|---|
| 9-10 | **Now-playing detection.** Implement `NotificationListenerService`. Detect music from any app. Auto-search when new song plays. This is the biggest single feature. |
| 11 | **Home screen widget.** Glance widget showing current artist's alternative platforms. |
| 12 | **ListenBrainz scrobbling.** Port the scrobbling logic from the macOS app. |
| 13-14 | **Polish and parity.** Quick Settings tile. Material You dynamic color. Tablet layout refinement. Edge cases. |

**Total: 12-14 weeks** from zero to feature parity, at 10-15 hours/week.

If you lean heavily on Claude Code for boilerplate generation and pattern translation from the SwiftUI codebase, the implementation phases (weeks 3-8) could compress significantly. The learning curve in weeks 1-2 is the part that cannot be shortcut.

---

## 7. Cost Breakdown

### One-time costs

| Item | Cost |
|---|---|
| Google Play Developer account | $25 |
| **Total one-time** | **$25** |

### Recurring costs

| Item | Cost | Notes |
|---|---|---|
| Google Play Developer account | $0/year | One-time fee, no annual renewal |
| Dependencies | $0 | All recommended libraries are open source (Apache 2.0 / MIT) |
| Android Studio | $0 | Free |
| CI/CD (GitHub Actions) | $0-10/month | Free tier includes 2,000 minutes/month. Android builds take 5-10 minutes. Likely free for this volume. |

### Comparison to Apple

| | Apple | Google |
|---|---|---|
| Developer account | $99/year | $25 one-time |
| IDE | Free (Xcode) | Free (Android Studio) |
| Review time | 1-3 days | 1-3 days |
| Test device required | Yes (or simulator) | Yes (or emulator) |

### CI/CD considerations

For automated builds and testing, a GitHub Actions workflow is straightforward:

```yaml
# .github/workflows/android.yml
on:
  push:
    paths: ['apps/android/**']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'
      - name: Build
        run: cd apps/android && ./gradlew assembleDebug
      - name: Test
        run: cd apps/android && ./gradlew test
```

This runs unit tests on every push that touches the Android directory. For Play Store uploads, you can add Fastlane or use the `r0adkll/upload-google-play` GitHub Action to automate deployments.

---

## Summary

The Android app is a tractable project. The Unstream iOS app is relatively thin — it is a search client with local persistence and background release checking. The server-side API does the hard work. The Android version calls the same APIs, stores the same data locally, and presents the same UI patterns in Compose instead of SwiftUI.

The biggest win Android offers over iOS is `NotificationListenerService` — the ability to detect now-playing music from any app without per-app hacking. This alone makes the Android app potentially more useful for the music detection use case than the macOS app.

**Recommended next steps:**
1. Register for a Google Play Developer account now ($25, identity verification takes days).
2. Install Android Studio and run through the first few Compose codelabs.
3. Set up the `apps/android/` project structure in the monorepo.
4. Build the search screen first — it is the core of the app and the fastest way to validate the development workflow.
