# Unstream macOS Menubar App - Active Listening

## Goal
Build a native macOS menubar app that:
1. Detects currently playing music from any app (Spotify, Apple Music, etc.) and shows alternative platform results
2. Allows manual artist search when nothing is playing or for on-demand lookups

## User Experience

### When Music is Playing
```
┌─────────────────────────────────────────┐
│  🎵  ← Menubar icon (changes when music playing)
└─────────────────────────────────────────┘
         │
         ▼ (click to open popover)
┌─────────────────────────────────────────┐
│  🔍 [Search for artists...           ]  │
├─────────────────────────────────────────┤
│  Now Playing                            │
│  ┌─────┐                                │
│  │ art │  Radiohead                     │
│  └─────┘  OK Computer                   │
│                                         │
│  Found on 5 platforms:                  │
│  🎵 Bandcamp  💿 Qobuz  🪺 Mirlo       │
│  🚐 Bandwagon  🏕️ Faircamp              │
│                                         │
│  [Open in Unstream]                     │
├─────────────────────────────────────────┤
│  ⚙️ Settings  |  Quit                   │
└─────────────────────────────────────────┘
```

### When Nothing is Playing (or after manual search)
```
┌─────────────────────────────────────────┐
│  🎵  ← Menubar icon (idle state)
└─────────────────────────────────────────┘
         │
         ▼ (click to open popover)
┌─────────────────────────────────────────┐
│  🔍 [Radiohead                       ]  │
├─────────────────────────────────────────┤
│  Search Results                         │
│                                         │
│  Found on 5 platforms:                  │
│  🎵 Bandcamp  💿 Qobuz  🪺 Mirlo       │
│  🚐 Bandwagon  🏕️ Faircamp              │
│                                         │
│  [Open in Unstream]                     │
├─────────────────────────────────────────┤
│  ⚙️ Settings  |  Quit                   │
└─────────────────────────────────────────┘
```

### Empty State (nothing playing, no search)
```
┌─────────────────────────────────────────┐
│  🔍 [Search for artists...           ]  │
├─────────────────────────────────────────┤
│                                         │
│  No music playing.                      │
│  Search for an artist above, or start   │
│  playing music to see results.          │
│                                         │
├─────────────────────────────────────────┤
│  ⚙️ Settings  |  Quit                   │
└─────────────────────────────────────────┘
```

## Technology Stack
- **Language**: Swift 5.9+
- **UI Framework**: SwiftUI
- **Now Playing**: MediaRemote private framework (with macOS 15.4+ workaround)
- **API**: Calls existing Unstream `/api/search/sources` endpoint
- **Min macOS**: 13.0 (Ventura) or 14.0 (Sonoma)

## Architecture

### Components
1. **UnstreamApp.swift** - Main app entry, menubar configuration
2. **MediaObserver.swift** - Monitors Now Playing via MediaRemote
3. **UnstreamAPI.swift** - Calls Unstream web API
4. **PopoverView.swift** - Main UI in popover (search bar + results)
5. **SearchBarView.swift** - Manual search input field
6. **ResultsView.swift** - Platform results display (shared between Now Playing and manual search)
7. **SettingsView.swift** - User preferences
8. **NotificationManager.swift** - Handles macOS notifications

### Data Flow
```
Two input sources → same output:

1. MediaRemote → MediaObserver → detect artist change
                                        ↓
                              UnstreamAPI.searchArtist()
                                        ↓
                              Update ResultsView + optionally notify

2. SearchBarView → user types artist name → submit
                                        ↓
                              UnstreamAPI.searchArtist()
                                        ↓
                              Update ResultsView (clears Now Playing display)
```

## Implementation Plan

### Phase 1: Project Setup
1. Create new Xcode project (macOS App, SwiftUI)
2. Configure as menubar-only app (LSUIElement = true)
3. Set up basic menubar icon with popover
4. Add app icon and bundle identifier

### Phase 2: MediaRemote Integration
Use the private MediaRemote framework to get Now Playing info.

**Key functions needed:**
```swift
// Load MediaRemote framework
let bundle = CFBundleCreate(kCFAllocatorDefault,
    NSURL(fileURLWithPath: "/System/Library/PrivateFrameworks/MediaRemote.framework"))

// Register for now playing notifications
MRMediaRemoteRegisterForNowPlayingNotifications(DispatchQueue.main)

// Get now playing info
MRMediaRemoteGetNowPlayingInfo(DispatchQueue.main) { info in
    let title = info[kMRMediaRemoteNowPlayingInfoTitle] as? String
    let artist = info[kMRMediaRemoteNowPlayingInfoArtist] as? String
    let album = info[kMRMediaRemoteNowPlayingInfoAlbum] as? String
    let artwork = info[kMRMediaRemoteNowPlayingInfoArtworkData] as? Data
}
```

**macOS 15.4+ Compatibility:**
- Use [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter) approach if direct access fails
- Or use JavaScript for Automation (JAX) fallback via `NowPlayingJAX`

### Phase 3: Unstream API Integration
```swift
struct UnstreamAPI {
    static let baseURL = "https://unstream.stream/api"

    func searchArtist(_ name: String) async throws -> SearchResponse {
        let url = URL(string: "\(baseURL)/search/sources?query=\(name.urlEncoded)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(SearchResponse.self, from: data)
    }
}
```

### Phase 4: UI Implementation

**PopoverView.swift:**
- Search bar at top (always visible)
- Conditional content area:
  - If manual search active: show search results
  - If music playing (and no manual search): show Now Playing info
  - If neither: show empty state with prompt
- Platform badges (reuse Unstream color scheme)
- "Open in Unstream" button (opens web with search query)
- Loading state while fetching

**SearchBarView.swift:**
- Text field with placeholder "Search for artists..."
- Search icon
- Submit on Enter key
- Clear button when text present
- When user submits: triggers API search, displays results inline

**ResultsView.swift:**
- Shared component for displaying platform results
- Shows artist name as header
- Platform badges in a flow layout
- "Open in Unstream" button
- Handles loading and error states

**SettingsView.swift:**
- Enable/disable notifications toggle
- Polling interval (how often to check for track changes)
- Launch at login toggle
- About section with version

### Phase 5: Notifications
```swift
func sendNotification(artist: String, platformCount: Int) {
    let content = UNMutableNotificationContent()
    content.title = "Found \(artist)"
    content.body = "Available on \(platformCount) ethical platforms"
    content.sound = .default

    let request = UNNotificationRequest(identifier: UUID().uuidString,
                                         content: content,
                                         trigger: nil)
    UNUserNotificationCenter.current().add(request)
}
```

### Phase 6: Polish & Distribution
- App icon design
- DMG installer or direct .app download
- Optional: Homebrew cask formula
- README with installation instructions

## File Structure
```
UnstreamMenubar/
├── UnstreamMenubar.xcodeproj
├── UnstreamMenubar/
│   ├── UnstreamMenubarApp.swift      # App entry point
│   ├── MenubarController.swift       # Menubar setup
│   ├── MediaObserver.swift           # MediaRemote wrapper
│   ├── MediaRemoteBridge.swift       # Private API bridge
│   ├── UnstreamAPI.swift             # API client
│   ├── Models/
│   │   ├── NowPlaying.swift
│   │   ├── SearchResponse.swift
│   │   └── AppState.swift            # Shared state (search query, results, now playing)
│   ├── Views/
│   │   ├── PopoverView.swift         # Main container view
│   │   ├── SearchBarView.swift       # Manual search input
│   │   ├── ResultsView.swift         # Platform results (shared)
│   │   ├── NowPlayingView.swift      # Current track display
│   │   ├── EmptyStateView.swift      # Nothing playing, no search
│   │   ├── PlatformBadge.swift       # Individual platform pill
│   │   └── SettingsView.swift        # Preferences
│   ├── NotificationManager.swift
│   └── Assets.xcassets
└── README.md
```

## Key Considerations

### MediaRemote Caveats
- Private API, not App Store eligible
- May break with macOS updates (especially 15.4+)
- Sometimes loses track of playback state
- Artwork may not always be available

### Debouncing
- Don't spam API on every track change
- Cache results for recently searched artists
- Minimum interval between API calls (e.g., 5 seconds)

### Privacy
- App only reads track metadata locally
- Only artist name sent to Unstream API
- No user tracking or analytics

## Development Steps

| Step | Task | Complexity |
|------|------|------------|
| 1 | Create Xcode project with menubar setup | Low |
| 2 | Implement basic popover UI with search bar | Low |
| 3 | Integrate Unstream API | Low |
| 4 | Implement manual search with inline results | Low |
| 5 | Add MediaRemote bridge for Now Playing | Medium |
| 6 | Add artist change detection & debouncing | Medium |
| 7 | Implement notifications | Low |
| 8 | Add settings persistence (UserDefaults) | Low |
| 9 | Handle macOS 15.4+ compatibility | Medium |
| 10 | Polish UI, add app icon | Low |
| 11 | Create distribution (DMG/README) | Low |

## Resources
- [MediaRemote Framework Docs](https://theapplewiki.com/wiki/Dev:MediaRemote.framework)
- [PrivateFrameworks/MediaRemote SPM](https://github.com/PrivateFrameworks/MediaRemote)
- [mediaremote-adapter (15.4+ fix)](https://github.com/ungive/mediaremote-adapter)
- [Tauri menubar example](https://github.com/ahkohd/tauri-macos-menubar-app-example) (for reference)
