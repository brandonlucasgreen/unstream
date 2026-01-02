# Unstream macOS Menubar App - Active Listening

## Goal
Build a native macOS menubar app that detects currently playing music from any app (Spotify, Apple Music, etc.) and shows alternative platform results from Unstream.

## User Experience
```
┌─────────────────────────────────────────┐
│  🎵  ← Menubar icon (changes when music playing)
└─────────────────────────────────────────┘
         │
         ▼ (click to open popover)
┌─────────────────────────────────────────┐
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
4. **PopoverView.swift** - Main UI in popover
5. **SettingsView.swift** - User preferences
6. **NotificationManager.swift** - Handles macOS notifications

### Data Flow
```
MediaRemote → MediaObserver → detect artist change
                    ↓
              UnstreamAPI.searchArtist()
                    ↓
              Update UI + optionally notify
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
- Current track info (artist, album, artwork)
- Platform badges (reuse Unstream color scheme)
- "Open in Unstream" button (opens web with `?url=` deep link or direct search)
- Loading state while fetching

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
│   │   └── SearchResponse.swift
│   ├── Views/
│   │   ├── PopoverView.swift
│   │   ├── TrackView.swift
│   │   ├── PlatformBadge.swift
│   │   └── SettingsView.swift
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
| 2 | Implement basic popover UI | Low |
| 3 | Add MediaRemote bridge for Now Playing | Medium |
| 4 | Integrate Unstream API | Low |
| 5 | Add artist change detection & debouncing | Medium |
| 6 | Implement notifications | Low |
| 7 | Add settings persistence (UserDefaults) | Low |
| 8 | Handle macOS 15.4+ compatibility | Medium |
| 9 | Polish UI, add app icon | Low |
| 10 | Create distribution (DMG/README) | Low |

## Resources
- [MediaRemote Framework Docs](https://theapplewiki.com/wiki/Dev:MediaRemote.framework)
- [PrivateFrameworks/MediaRemote SPM](https://github.com/PrivateFrameworks/MediaRemote)
- [mediaremote-adapter (15.4+ fix)](https://github.com/ungive/mediaremote-adapter)
- [Tauri menubar example](https://github.com/ahkohd/tauri-macos-menubar-app-example) (for reference)
