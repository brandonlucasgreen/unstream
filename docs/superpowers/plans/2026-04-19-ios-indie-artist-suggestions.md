# iOS Indie Artist Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the iOS Search tab's empty state with a 2-column grid of 30 randomly-sampled artists from the Indie Artist Index, with pull-to-refresh and a local cache fallback.

**Architecture:** New `IndieArtistDirectoryService` (a `@MainActor ObservableObject`) owns the directory data, persists it to a JSON file in the app's Caches directory, and publishes a current 30-artist sample. A new `IndieArtistSuggestionsView` renders the grid using `LazyVGrid` and is wired into `SearchTab`'s no-query branch. The service fetches via a new `fetchArtistDirectory()` method on the existing `UnstreamAPI` actor.

**Tech Stack:** SwiftUI (iOS 16+), Swift Concurrency (`async/await`, `@MainActor`), `URLSession` via the existing `UnstreamAPI` actor, `FileManager` for disk caching.

**Spec:** `docs/superpowers/specs/2026-04-19-ios-indie-artist-suggestions-design.md`

**Testing:** No Swift test target exists in `apps/mac/Unstream.xcodeproj`. Verification is the manual checklist in the spec's Testing section, performed by the user after the implementation lands.

---

## File Structure

**New files (2):**

- `apps/mac/Unstream/Services/IndieArtistDirectoryService.swift` — contains the `IndieArtist` model and the `IndieArtistDirectoryService` `ObservableObject`. Co-located because both are small and only used together.
- `apps/mac/Unstream/Views/iOS/IndieArtistSuggestionsView.swift` — contains the grid view and the `IndieArtistCard` subview. iOS-only (`#if os(iOS)`).

**Modified files (4):**

- `apps/mac/Unstream/UnstreamAPI.swift` — add `fetchArtistDirectory()` method.
- `apps/mac/Unstream/UnstreamApp.swift` — instantiate the service in `AppStateContainer` and inject it on iOS.
- `apps/mac/Unstream/Views/iOS/SearchTab.swift` — replace the empty-state branch with `IndieArtistSuggestionsView`.
- `apps/mac/Unstream.xcodeproj/project.pbxproj` — register the 2 new Swift files in the iOS app target.

---

## Task 1: Add `fetchArtistDirectory()` to UnstreamAPI

**Files:**
- Modify: `apps/mac/Unstream/UnstreamAPI.swift`

- [ ] **Step 1: Add the fetch method to the `UnstreamAPI` actor**

Insert this method inside the `UnstreamAPI` actor (after `fetchMusicBrainzData`, before `normalizeForComparison` — around line 67):

```swift
    func fetchArtistDirectory() async throws -> [IndieArtist] {
        guard let url = URL(string: "\(baseURL)/artist-directory") else {
            throw APIError.invalidURL
        }

        let (data, response) = try await session.data(from: url)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw APIError.requestFailed
        }

        struct DirectoryResponse: Decodable {
            let artists: [IndieArtist]
        }

        let decoded = try JSONDecoder().decode(DirectoryResponse.self, from: data)
        return decoded.artists
    }
```

Note: `IndieArtist` will be defined in Task 2. This step's compile won't succeed until Task 2 lands — that's fine; we'll commit them together at the end of Task 2.

- [ ] **Step 2: Confirm no commit yet**

Do not commit. Move to Task 2.

---

## Task 2: Create `IndieArtist` model and `IndieArtistDirectoryService`

**Files:**
- Create: `apps/mac/Unstream/Services/IndieArtistDirectoryService.swift`

- [ ] **Step 1: Create the file with the model and service**

Write the entire file with this content:

```swift
import Foundation
import SwiftUI

// MARK: - Model

struct IndieArtist: Codable, Identifiable, Equatable {
    let slug: String
    let name: String
    let imageUrl: String?

    var id: String { slug }
}

// MARK: - Service

@MainActor
class IndieArtistDirectoryService: ObservableObject {
    enum LoadState {
        case idle
        case loading
        case loaded
        case failed
    }

    @Published private(set) var artists: [IndieArtist] = []
    @Published private(set) var sample: [IndieArtist] = []
    @Published private(set) var loadState: LoadState = .idle

    private let api: UnstreamAPI
    private let sampleSize = 30
    private let cacheFileName = "indie-artist-directory.json"

    init(api: UnstreamAPI = UnstreamAPI()) {
        self.api = api
        loadFromCache()
        if !artists.isEmpty {
            self.loadState = .loaded
            self.sample = pickSample(from: artists)
        }
    }

    /// Fetches the directory if we haven't loaded it yet this session, or refreshes
    /// silently in the background. Does NOT reshuffle an existing sample — only
    /// `refresh()` (pull-to-refresh) does that.
    func loadIfNeeded() async {
        if loadState == .loading { return }
        let hadSample = !sample.isEmpty
        loadState = .loading
        do {
            let fetched = try await api.fetchArtistDirectory()
            self.artists = fetched
            saveToCache(fetched)
            if !hadSample {
                self.sample = pickSample(from: fetched)
            }
            self.loadState = .loaded
        } catch {
            // Keep any cached artists — only mark failed if we have nothing to show.
            if artists.isEmpty {
                self.loadState = .failed
            } else {
                self.loadState = .loaded
            }
        }
    }

    /// Pull-to-refresh: re-fetches and reshuffles regardless of fetch outcome.
    func refresh() async {
        do {
            let fetched = try await api.fetchArtistDirectory()
            self.artists = fetched
            saveToCache(fetched)
        } catch {
            // Ignore — we still reshuffle from existing data so the user sees change.
        }
        self.sample = pickSample(from: artists)
        if !artists.isEmpty {
            self.loadState = .loaded
        }
    }

    private func pickSample(from source: [IndieArtist]) -> [IndieArtist] {
        guard !source.isEmpty else { return [] }
        return Array(source.shuffled().prefix(sampleSize))
    }

    // MARK: - Cache

    private var cacheURL: URL? {
        guard let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        return dir.appendingPathComponent(cacheFileName)
    }

    private func loadFromCache() {
        guard let url = cacheURL,
              FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([IndieArtist].self, from: data) else {
            return
        }
        self.artists = decoded
    }

    private func saveToCache(_ artists: [IndieArtist]) {
        guard let url = cacheURL,
              let data = try? JSONEncoder().encode(artists) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
```

- [ ] **Step 2: Commit Tasks 1 + 2 together**

```bash
git add apps/mac/Unstream/UnstreamAPI.swift apps/mac/Unstream/Services/IndieArtistDirectoryService.swift
git commit -m "feat(ios): add indie artist directory service and API method"
```

Note: the project will not build yet because the new file isn't registered in `project.pbxproj` — that happens in Task 6.

---

## Task 3: Create `IndieArtistSuggestionsView` and `IndieArtistCard`

**Files:**
- Create: `apps/mac/Unstream/Views/iOS/IndieArtistSuggestionsView.swift`

- [ ] **Step 1: Create the view file**

Write the entire file with this content:

```swift
#if os(iOS)
import SwiftUI

struct IndieArtistSuggestionsView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var directory: IndieArtistDirectoryService

    private let columns = [
        GridItem(.flexible(), spacing: 16),
        GridItem(.flexible(), spacing: 16),
    ]

    var body: some View {
        Group {
            if directory.loadState == .failed && directory.artists.isEmpty {
                fallbackEmptyState
            } else if directory.artists.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 60)
            } else {
                gridContent
            }
        }
        .task {
            await directory.loadIfNeeded()
        }
        .refreshable {
            await directory.refresh()
        }
    }

    private var gridContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            if isBandcampFriday() {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .foregroundColor(Color(hex: "#1DA0C3") ?? .blue)
                    Text("It's Bandcamp Friday!")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(Color(hex: "#1DA0C3") ?? .blue)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background((Color(hex: "#1DA0C3") ?? .blue).opacity(0.1))
                .cornerRadius(8)
                .frame(maxWidth: .infinity, alignment: .center)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Discover indie artists")
                    .font(.title3)
                    .fontWeight(.semibold)
                Text("Tap any artist to find them on platforms that pay fairly")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 4)

            LazyVGrid(columns: columns, spacing: 20) {
                ForEach(directory.sample) { artist in
                    IndieArtistCard(artist: artist) {
                        appState.searchQuery = artist.name
                        Task { await appState.performSearch() }
                    }
                }
            }
        }
    }

    private var fallbackEmptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "music.note.house")
                .font(.system(size: 48))
                .foregroundColor(.secondary.opacity(0.5))

            Text("Search for an artist to find them\non ethical music platforms")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            if isBandcampFriday() {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .foregroundColor(Color(hex: "#1DA0C3") ?? .blue)
                    Text("It's Bandcamp Friday!")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(Color(hex: "#1DA0C3") ?? .blue)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background((Color(hex: "#1DA0C3") ?? .blue).opacity(0.1))
                .cornerRadius(8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 60)
    }
}

struct IndieArtistCard: View {
    let artist: IndieArtist
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 8) {
                avatar
                Text(artist.name)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundColor(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var avatar: some View {
        if let urlString = artist.imageUrl, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                case .empty, .failure:
                    placeholderCircle
                @unknown default:
                    placeholderCircle
                }
            }
            .frame(width: 140, height: 140)
            .clipShape(Circle())
        } else {
            placeholderCircle
        }
    }

    private var placeholderCircle: some View {
        ZStack {
            Circle()
                .fill(Color.secondary.opacity(0.15))
            Text(artist.name.prefix(1).uppercased())
                .font(.system(size: 44, weight: .semibold))
                .foregroundColor(.secondary)
        }
        .frame(width: 140, height: 140)
    }
}
#endif
```

- [ ] **Step 2: Commit**

```bash
git add apps/mac/Unstream/Views/iOS/IndieArtistSuggestionsView.swift
git commit -m "feat(ios): add indie artist suggestions grid view"
```

---

## Task 4: Wire `IndieArtistDirectoryService` into `AppStateContainer`

**Files:**
- Modify: `apps/mac/Unstream/UnstreamApp.swift`

- [ ] **Step 1: Add the service as a property on `AppStateContainer`**

In `apps/mac/Unstream/UnstreamApp.swift`, locate the `AppStateContainer` class (around line 18). Add a stored property below `releaseAlertManager`:

Find this block (around line 21–23):

```swift
    let appState = AppState()
    let supportListManager: SupportListManager
    let releaseAlertManager: ReleaseAlertManager
```

Replace with:

```swift
    let appState = AppState()
    let supportListManager: SupportListManager
    let releaseAlertManager: ReleaseAlertManager
    #if os(iOS)
    let indieArtistDirectory = IndieArtistDirectoryService()
    #endif
```

- [ ] **Step 2: Inject the service into the iOS environment**

In the same file, locate the `WindowGroup` block inside `UnstreamApp.body` (around line 125). Find:

```swift
            iOSContentView()
                .environmentObject(container.appState)
                .environmentObject(container.supportListManager)
                .environmentObject(container.releaseAlertManager)
```

Replace with:

```swift
            iOSContentView()
                .environmentObject(container.appState)
                .environmentObject(container.supportListManager)
                .environmentObject(container.releaseAlertManager)
                .environmentObject(container.indieArtistDirectory)
```

- [ ] **Step 3: Commit**

```bash
git add apps/mac/Unstream/UnstreamApp.swift
git commit -m "feat(ios): inject IndieArtistDirectoryService into app state"
```

---

## Task 5: Replace empty-state branch in `SearchTab`

**Files:**
- Modify: `apps/mac/Unstream/Views/iOS/SearchTab.swift`

- [ ] **Step 1: Replace the empty-state branch**

Open `apps/mac/Unstream/Views/iOS/SearchTab.swift`. Find the `else` branch starting at line 34 (the `// Empty state` block) and ending at line 63 (closing of the `VStack` with `.padding(.top, 60)`).

Specifically, replace this block:

```swift
                    } else {
                        // Empty state
                        VStack(spacing: 16) {
                            Image(systemName: "music.note.house")
                                .font(.system(size: 48))
                                .foregroundColor(.secondary.opacity(0.5))

                            Text("Search for an artist to find them\non ethical music platforms")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                                .multilineTextAlignment(.center)

                            if isBandcampFriday() {
                                HStack(spacing: 6) {
                                    Image(systemName: "sparkles")
                                        .foregroundColor(Color(hex: "#1DA0C3") ?? .blue)
                                    Text("It's Bandcamp Friday!")
                                        .font(.subheadline)
                                        .fontWeight(.medium)
                                        .foregroundColor(Color(hex: "#1DA0C3") ?? .blue)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background((Color(hex: "#1DA0C3") ?? .blue).opacity(0.1))
                                .cornerRadius(8)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 60)
                    }
```

With:

```swift
                    } else {
                        IndieArtistSuggestionsView()
                    }
```

- [ ] **Step 2: Commit**

```bash
git add apps/mac/Unstream/Views/iOS/SearchTab.swift
git commit -m "feat(ios): show indie artist suggestions when search is empty"
```

---

## Task 6: Register new Swift files in the Xcode project

`project.pbxproj` files are sensitive. Each new Swift file requires four entries in the file: a `PBXBuildFile` line (top section), a `PBXFileReference` line (middle section), membership in a `PBXGroup` `children` array, and inclusion in the iOS target's `Sources` build phase.

The two new files are iOS-only, so their `PBXBuildFile` entries must include `platformFilters = (ios, );` to mirror how `SearchTab.swift` is registered.

**Files:**
- Modify: `apps/mac/Unstream.xcodeproj/project.pbxproj`

- [ ] **Step 1: Generate four UUIDs for `IndieArtistDirectoryService.swift` and four for `IndieArtistSuggestionsView.swift`**

Generate 8 unique 24-character uppercase hex IDs (the format Xcode uses). You can produce them with:

```bash
for i in $(seq 1 8); do head -c 12 /dev/urandom | hexdump -e '/1 "%02X"'; echo; done
```

Note them down. Refer to them below as:
- `BUILD_SVC` and `FILE_SVC` — for `IndieArtistDirectoryService.swift`
- `BUILD_VIEW` and `FILE_VIEW` — for `IndieArtistSuggestionsView.swift`

You'll generate 4 IDs per file but only need 2 each (the build-file UUID and the file-reference UUID), so generate 4 total — discard the rest.

- [ ] **Step 2: Add `PBXBuildFile` entries**

Locate the `PBXBuildFile` section (begins after the comment `/* Begin PBXBuildFile section */`, around line 8). Find the existing line for `SearchTab.swift` (around line 13):

```
		11B4891578B50BCF51D68613 /* SearchTab.swift in Sources */ = {isa = PBXBuildFile; fileRef = E330692CA1EC213166D9351F /* SearchTab.swift */; platformFilters = (ios, ); };
```

Immediately after it, add two new lines (replace `<BUILD_SVC>`, `<FILE_SVC>`, `<BUILD_VIEW>`, `<FILE_VIEW>` with the IDs you generated):

```
		<BUILD_SVC> /* IndieArtistDirectoryService.swift in Sources */ = {isa = PBXBuildFile; fileRef = <FILE_SVC> /* IndieArtistDirectoryService.swift */; platformFilters = (ios, ); };
		<BUILD_VIEW> /* IndieArtistSuggestionsView.swift in Sources */ = {isa = PBXBuildFile; fileRef = <FILE_VIEW> /* IndieArtistSuggestionsView.swift */; platformFilters = (ios, ); };
```

- [ ] **Step 3: Add `PBXFileReference` entries**

Locate the `PBXFileReference` section (begins after the comment `/* Begin PBXFileReference section */`). Find the line for `SearchTab.swift` (around line 133):

```
		E330692CA1EC213166D9351F /* SearchTab.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SearchTab.swift; sourceTree = "<group>"; };
```

Immediately after it, add:

```
		<FILE_SVC> /* IndieArtistDirectoryService.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = IndieArtistDirectoryService.swift; sourceTree = "<group>"; };
		<FILE_VIEW> /* IndieArtistSuggestionsView.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = IndieArtistSuggestionsView.swift; sourceTree = "<group>"; };
```

- [ ] **Step 4: Add the service file to the Services group**

Locate the `Services` group's `children` array. Find this block (around line 154–164):

```
			... Services group {
				isa = PBXGroup;
				children = (
					...
					E6904B96B5E95C5FF26DABC1 /* QobuzReleaseChecker.swift */,
					673FC4B1F41A233725896DB8 /* ReleaseCheckAPI.swift */,
				);
				path = Services;
				sourceTree = "<group>";
			};
```

(Find it by searching for `path = Services;`.)

Add the new file reference at the end of the children list, before the closing `);`:

```
					673FC4B1F41A233725896DB8 /* ReleaseCheckAPI.swift */,
					<FILE_SVC> /* IndieArtistDirectoryService.swift */,
				);
```

- [ ] **Step 5: Add the view file to the iOS group**

Locate the `iOS` group (around line 166–177):

```
			57415AB9B21702B3D6AFBF3E /* iOS */ = {
				isa = PBXGroup;
				children = (
					5033CFF636FB4C7C07D315A6 /* iOSContentView.swift */,
					359150E4043D5233395827D3 /* iOSSettingsTab.swift */,
					2C8F1E48E643DCC1EECD4A93 /* ReleasesTab.swift */,
					E330692CA1EC213166D9351F /* SearchTab.swift */,
					F8C60F297D83E962E0D769E7 /* SupportListTab.swift */,
				);
				path = iOS;
				sourceTree = "<group>";
			};
```

Add the new view at the end of the children list, before the closing `);`:

```
					F8C60F297D83E962E0D769E7 /* SupportListTab.swift */,
					<FILE_VIEW> /* IndieArtistSuggestionsView.swift */,
				);
```

- [ ] **Step 6: Add both files to the iOS target's `Sources` build phase**

Locate the iOS app target's `Sources` build phase. Find the line for `SearchTab.swift` in the `Sources` section (around line 441):

```
				11B4891578B50BCF51D68613 /* SearchTab.swift in Sources */,
```

Immediately after it, add:

```
				<BUILD_SVC> /* IndieArtistDirectoryService.swift in Sources */,
				<BUILD_VIEW> /* IndieArtistSuggestionsView.swift in Sources */,
```

- [ ] **Step 7: Validate the project file parses**

Run:

```bash
plutil -lint apps/mac/Unstream.xcodeproj/project.pbxproj
```

Expected output: `apps/mac/Unstream.xcodeproj/project.pbxproj: OK`

If it fails, you've left a syntax error — review your edits carefully. Each new entry must end with a semicolon and (where applicable) a comma.

- [ ] **Step 8: Build the iOS target to confirm everything compiles**

Run:

```bash
cd apps/mac && xcodebuild -project Unstream.xcodeproj -scheme Unstream -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -20
```

Expected: `** BUILD SUCCEEDED **` near the end.

If the build fails with errors about missing types or symbols, double-check that the new file paths in step 3's `PBXFileReference` entries match the actual file locations on disk relative to their parent groups (`IndieArtistDirectoryService.swift` lives in `Services/`, `IndieArtistSuggestionsView.swift` lives in `Views/iOS/`).

- [ ] **Step 9: Commit**

```bash
git add apps/mac/Unstream.xcodeproj/project.pbxproj
git commit -m "build(ios): register indie artist suggestions files in Xcode project"
```

---

## Task 7: Manual verification

The iOS app has no automated test target. The user will run the verification checklist below on a real device or iOS Simulator.

- [ ] **Step 1: Build and run in the iOS Simulator**

```bash
cd apps/mac && xcodebuild -project Unstream.xcodeproj -scheme Unstream -destination 'platform=iOS Simulator,name=iPhone 15' -configuration Debug build 2>&1 | tail -5
```

Then open `apps/mac/Unstream.xcodeproj` in Xcode and run the iOS scheme on a Simulator (Cmd-R), or instruct the user to do so.

- [ ] **Step 2: Walk through the manual verification checklist**

From the spec's Testing section, confirm each:

1. **Fresh install:** Open the Search tab. Within ~2s, the grid populates with up to 30 artist tiles.
2. **Repeat launch:** Kill and relaunch while online. The grid appears instantly (cache-served), then refreshes silently in the background. The displayed sample does not change.
3. **Pull-to-refresh:** Swipe down on the grid. The 30 displayed artists change to a new random subset.
4. **Tap behavior:** Tap any tile. The search bar populates with that artist's name and search results appear, replacing the grid.
5. **Clear search:** Clear the search text. The grid reappears with the same sample as before the search.
6. **Offline cold start:** Turn on airplane mode, delete and reinstall, open the app. The empty-state hero (music-note icon + prompt) appears.
7. **Offline with cache:** After at least one successful launch, turn on airplane mode and reopen. The cached grid still appears.

- [ ] **Step 3: Report results**

If any check fails, surface the failure to the user with details (which step, what you saw vs. expected). Do not mark the implementation complete until all 7 pass.

---

## Notes for the implementer

- **iOS-only code:** Both new Swift files contain iOS-specific patterns. `IndieArtistSuggestionsView.swift` is wrapped in `#if os(iOS)`. `IndieArtistDirectoryService.swift` is not wrapped because it has no platform dependencies, but it's only referenced from iOS code (gated by `#if os(iOS)` in `AppStateContainer`).
- **`@MainActor` consistency:** The service is `@MainActor` so its `@Published` properties update on the main thread. The `UnstreamAPI` actor handles network calls off the main thread; awaiting it from `@MainActor` code is the correct pattern.
- **Cache file lifetime:** The Caches directory may be purged by iOS under storage pressure. This is expected — the next view appearance will re-fetch.
- **No new dependencies.** Everything uses existing frameworks (`Foundation`, `SwiftUI`).
- **Helpers used:** `isBandcampFriday()` (defined in `apps/mac/Unstream/BandcampFriday.swift`) and `Color(hex:)` (defined elsewhere in the project — referenced by the existing `SearchTab.swift` empty state). Both are already in scope from the iOS app target.
