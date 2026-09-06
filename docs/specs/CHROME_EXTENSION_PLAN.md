---
status: Done
---
# Unstream Chrome Extension - Implementation Plan

> **Note (2026-04-02):** This document was the original planning spec. The actual
> implementation diverged significantly -- there is no `lib/` directory (api.js,
> storage.js, license.js), the file structure lives under `apps/extension/`, and
> Firefox support was added. Refer to the actual code in `apps/extension/` and
> `CLAUDE.md` for current architecture.

## Overview
A Chrome extension that detects music playing in browser tabs (Spotify Web, YouTube, YouTube Music, Apple Music) and shows ethical alternatives via the Unstream API.

## Architecture

### Extension Components
```
chrome-extension/
├── manifest.json          # Extension manifest (v3)
├── popup/
│   ├── popup.html         # Main popup UI
│   ├── popup.css          # Styles
│   └── popup.js           # Popup logic
├── background/
│   └── service-worker.js  # Background service worker
├── content/
│   ├── spotify.js         # Spotify Web Player detection
│   ├── youtube.js         # YouTube/YouTube Music detection
│   └── apple-music.js     # Apple Music web detection
├── lib/
│   ├── api.js             # Unstream API client
│   ├── storage.js         # chrome.storage.sync wrapper
│   └── license.js         # Lemon Squeezy license validation
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Detection Strategy

**Content Scripts** inject into streaming pages and extract now-playing info:

| Platform | URL Pattern | Detection Method |
|----------|-------------|------------------|
| Spotify Web | `open.spotify.com/*` | DOM: `[data-testid="now-playing-widget"]` or Media Session API |
| YouTube | `youtube.com/watch*` | DOM: video title + channel name, or Media Session API |
| YouTube Music | `music.youtube.com/*` | DOM: `.ytmusic-player-bar`, or Media Session API |
| Apple Music | `music.apple.com/*` | DOM: `.web-chrome-playback-lcd` |

**Media Session API** (preferred where available):
```javascript
if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
  const { title, artist, album } = navigator.mediaSession.metadata;
}
```

### Data Flow
```
Content Script → Message → Service Worker → Unstream API
                              ↓
                         chrome.storage
                              ↓
                           Popup UI
```

1. Content script detects music change, sends message to service worker
2. Service worker calls Unstream API (`/api/search/sources?q=ARTIST`)
3. Results cached in `chrome.storage.local` (5 min TTL)
4. Popup reads from storage and displays results
5. Lazy enrichment via `/api/search/musicbrainz` for social links

### API Integration

Uses existing Unstream API endpoints (same as web/Mac):
- `GET /api/search/sources?q={artist}` - Quick search results
- `GET /api/search/musicbrainz?query={artist}` - Enrichment (official site, social links, pre-2005 flag)
- `GET /api/resolve/url?url={spotify/apple url}` - Extract artist from streaming URL

### Storage Schema

```javascript
// chrome.storage.sync (syncs across devices, 100KB limit)
{
  "savedArtists": ["Artist Name 1", "Artist Name 2"],
  "license": {
    "key": "XXXX-XXXX-XXXX-XXXX",
    "validatedAt": 1704672000000,
    "status": "active"
  },
  "settings": {
    "showNotifications": true,
    "autoPopup": false
  }
}

// chrome.storage.local (larger, device-only)
{
  "cache:Artist Name": {
    "results": [...],
    "timestamp": 1704672000000
  },
  "enrichment:Artist Name": {
    "musicbrainz": {...},
    "timestamp": 1704672000000
  }
}
```

### License Management

Matches Mac app pattern with Lemon Squeezy:
- Store ID: 188119 (same as Mac app)
- Free tier: Basic search results
- Pro tier:
  - Saved artists sync
  - Social links
  - Notifications
  - (Future) Auto-save history

Validation flow:
1. User enters license key in popup settings
2. Extension validates via Lemon Squeezy API
3. Cache validation for 7 days (like Mac app)
4. Revalidate on extension update or manual refresh

## UI Design

### Popup (400x500px max)
```
┌─────────────────────────────────────┐
│  🎵 Unstream                    ⚙️  │
├─────────────────────────────────────┤
│  Now Playing:                       │
│  ┌─────────────────────────────────┐│
│  │ Artist Name                     ││
│  │ "Song Title"                    ││
│  └─────────────────────────────────┘│
├─────────────────────────────────────┤
│  Listen Ethically:                  │
│  🎵 Bandcamp    💿 Artist Site     │
│  📻 Radio       📚 Library         │
│                                     │
│  Social:                            │
│  📷 🎬 🎵 📘                        │
├─────────────────────────────────────┤
│  [★ Save Artist]                    │
├─────────────────────────────────────┤
│  Saved Artists (3):                 │
│  • Artist 1  • Artist 2  • Artist 3 │
└─────────────────────────────────────┘
```

### States
- **Idle**: "Play music in Spotify, YouTube, or Apple Music to get started"
- **Detecting**: "Listening for music..."
- **Results**: Full results view
- **No Results**: "No ethical sources found for [Artist]"
- **Offline**: "Check your internet connection"

## Implementation Phases

### Phase 1: Core Detection & Search ✅
- [x] Set up Chrome extension boilerplate (manifest v3)
- [x] Implement Spotify Web content script
- [x] Implement YouTube/YouTube Music content script
- [x] Create service worker with API client
- [x] Build basic popup UI with results display
- [x] Add result caching (5 min)

### Phase 2: Saved Artists & Settings ✅
- [x] Implement chrome.storage.sync for saved artists
- [x] Add "Save Artist" button functionality
- [x] Create settings page
- [x] Add manual artist search in popup

### Phase 3: Enrichment & Social Links ✅
- [x] Add MusicBrainz lazy enrichment
- [x] Display social links in popup
- [x] Add official website link

### Phase 4: License Integration ✅
- [x] Implement Lemon Squeezy validation
- [x] Gate pro features behind license
- [x] Add license entry UI in settings
- [x] Add upgrade prompts for free users

### Phase 5: Polish & Release
- [x] Add Apple Music web support
- [ ] Implement notifications (optional)
- [x] Create extension icons
- [ ] Write Chrome Web Store listing
- [ ] Submit for review

## Testing Instructions

To test the extension locally:

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `chrome-extension` folder
5. The extension icon should appear in your toolbar

### Test Scenarios:
1. **Spotify Web**: Open open.spotify.com, play a song, click extension icon
2. **YouTube**: Watch a music video on youtube.com, click extension
3. **YouTube Music**: Play something on music.youtube.com
4. **Apple Music**: Play on music.apple.com (if you have subscription)
5. **Manual Search**: Type an artist name in the search box
6. **Badge**: Verify green badge appears when music is detected

## Technical Considerations

### Manifest V3 Requirements
- Service workers instead of background pages
- No remote code execution
- Declarative content scripts
- Limited to specific host permissions

### Permissions Needed
```json
{
  "permissions": [
    "storage",
    "activeTab",
    "notifications"
  ],
  "host_permissions": [
    "https://open.spotify.com/*",
    "https://www.youtube.com/*",
    "https://music.youtube.com/*",
    "https://music.apple.com/*",
    "https://unstream.stream/*"
  ]
}
```

### Rate Limiting
- Cache results aggressively (5 min like Mac app)
- Debounce detection (don't re-search same artist within 30s)
- Batch MusicBrainz enrichment requests

## Decisions Made
1. **Browser support**: Chrome only for initial release (Firefox can be added later)
2. **Free tier limits**: No saved artists in free tier (Pro-only feature)
3. **Badge**: Yes, show green badge with result count when music is detected
4. **Notification frequency**: TBD (notifications not yet implemented)
