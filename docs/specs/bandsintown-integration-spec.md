# Bandsintown Integration Spec

**Status**: Pending API Access
**Last Updated**: January 2025
**Author**: Generated with Claude

---

## Overview

Integrate Bandsintown concert data into Unstream to show upcoming live shows for artists. This adds a new platform category "Live Shows" alongside existing music platforms and social links.

### Goals

- Display upcoming concerts/tours for searched artists
- Provide direct links to ticket purchases
- Show venue, date, and location information
- Integrate seamlessly with existing search flow

---

## API Integration

### Authentication

Bandsintown uses a simple `app_id` query parameter for authentication:

```
https://rest.bandsintown.com/artists/{artist_name}/events?app_id=YOUR_APP_ID
```

**Requirements**:
- Register for API access through Bandsintown Developer Relations
- Store `app_id` as environment variable (`BANDSINTOWN_APP_ID`)

### Endpoints

#### Get Artist Info
```
GET https://rest.bandsintown.com/artists/{artist_name}?app_id={app_id}
```

**Response**:
```json
{
  "id": "123",
  "name": "Artist Name",
  "url": "https://www.bandsintown.com/a/123",
  "image_url": "https://...",
  "thumb_url": "https://...",
  "facebook_page_url": "https://facebook.com/...",
  "mbid": "musicbrainz-id",
  "tracker_count": 12345,
  "upcoming_event_count": 5
}
```

#### Get Artist Events
```
GET https://rest.bandsintown.com/artists/{artist_name}/events?app_id={app_id}&date=upcoming
```

**Parameters**:
- `date`: `upcoming` | `past` | `all` | `YYYY-MM-DD,YYYY-MM-DD` (range)

**Response**:
```json
[
  {
    "id": "123456",
    "artist_id": "123",
    "url": "https://www.bandsintown.com/e/123456",
    "on_sale_datetime": "2025-01-15T10:00:00",
    "datetime": "2025-03-15T20:00:00",
    "description": "Tour Name",
    "venue": {
      "name": "Madison Square Garden",
      "latitude": "40.7505",
      "longitude": "-73.9934",
      "city": "New York",
      "region": "NY",
      "country": "United States"
    },
    "offers": [
      {
        "type": "Tickets",
        "url": "https://tickets.example.com/...",
        "status": "available"
      }
    ],
    "lineup": ["Artist Name", "Opening Act"]
  }
]
```

---

## Data Models

### TypeScript Types

```typescript
// src/types/bandsintown.ts

interface BandsintownArtist {
  id: string;
  name: string;
  url: string;
  image_url: string;
  thumb_url: string;
  facebook_page_url?: string;
  mbid?: string;
  tracker_count: number;
  upcoming_event_count: number;
}

interface BandsintownVenue {
  name: string;
  latitude: string;
  longitude: string;
  city: string;
  region: string;
  country: string;
}

interface BandsintownOffer {
  type: string;
  url: string;
  status: "available" | "sold_out" | "unavailable";
}

interface BandsintownEvent {
  id: string;
  artist_id: string;
  url: string;
  on_sale_datetime?: string;
  datetime: string;
  description?: string;
  venue: BandsintownVenue;
  offers: BandsintownOffer[];
  lineup: string[];
}

// Normalized for Unstream
interface LiveShowResult {
  id: string;
  date: Date;
  venueName: string;
  city: string;
  region?: string;
  country: string;
  ticketUrl?: string;
  ticketStatus: "available" | "sold_out" | "unavailable" | "notify";
  bandsintownUrl: string;
}
```

### Swift Models (Mac App)

```swift
// Models/LiveShow.swift

struct LiveShowResult: Codable, Identifiable {
    let id: String
    let date: Date
    let venueName: String
    let city: String
    let region: String?
    let country: String
    let ticketUrl: String?
    let ticketStatus: TicketStatus
    let bandsintownUrl: String

    enum TicketStatus: String, Codable {
        case available
        case soldOut = "sold_out"
        case unavailable
        case notify
    }
}
```

---

## Search Flow Integration

### Backend Changes

#### New Netlify Function: `search-bandsintown.ts`

```typescript
// netlify/functions/search-bandsintown.ts

import { Handler } from "@netlify/functions";

const BANDSINTOWN_API = "https://rest.bandsintown.com";
const APP_ID = process.env.BANDSINTOWN_APP_ID;

export const handler: Handler = async (event) => {
  const artistName = event.queryStringParameters?.artist;

  if (!artistName || !APP_ID) {
    return { statusCode: 400, body: "Missing artist or API key" };
  }

  try {
    // Fetch upcoming events
    const response = await fetch(
      `${BANDSINTOWN_API}/artists/${encodeURIComponent(artistName)}/events?app_id=${APP_ID}&date=upcoming`
    );

    if (!response.ok) {
      return { statusCode: response.status, body: "Bandsintown API error" };
    }

    const events = await response.json();

    // Transform to Unstream format
    const liveShows = events.slice(0, 5).map((event: any) => ({
      id: event.id,
      date: event.datetime,
      venueName: event.venue.name,
      city: event.venue.city,
      region: event.venue.region,
      country: event.venue.country,
      ticketUrl: event.offers?.[0]?.url,
      ticketStatus: event.offers?.[0]?.status || "unavailable",
      bandsintownUrl: event.url,
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: liveShows }),
    };
  } catch (error) {
    return { statusCode: 500, body: "Internal error" };
  }
};
```

#### Integration with Main Search

Option A: **Parallel fetch** - Call Bandsintown alongside existing sources
```typescript
// In search-sources.ts
const [platformResults, liveShows] = await Promise.all([
  searchPlatforms(artistName),
  searchBandsintown(artistName),
]);
```

Option B: **Separate endpoint** - Keep live shows as optional/lazy-loaded
```typescript
// Only fetch when user expands "Live Shows" section
```

**Recommendation**: Option B - keeps main search fast, live shows can load asynchronously.

---

## UI/UX Design

### Web App

New collapsible section below social platforms:

```
┌─────────────────────────────────────────┐
│ 🎵 Bandcamp  🎵 Mirlo  🌐 Official Site │
├─────────────────────────────────────────┤
│ 📱 Instagram  📘 Facebook  🎵 TikTok    │
├─────────────────────────────────────────┤
│ 🎤 Live Shows (3 upcoming)         [▼]  │
│  ┌────────────────────────────────────┐ │
│  │ Mar 15 • Madison Square Garden    │ │
│  │ New York, NY                      │ │
│  │ [🎫 Get Tickets]                  │ │
│  └────────────────────────────────────┘ │
│  ┌────────────────────────────────────┐ │
│  │ Mar 18 • The Forum                │ │
│  │ Los Angeles, CA                   │ │
│  │ [🔔 Notify Me]                    │ │
│  └────────────────────────────────────┘ │
│  [View all on Bandsintown →]            │
└─────────────────────────────────────────┘
```

### Mac App

Add to `ResultsView.swift`:

```swift
// New section in artist results
if !artist.liveShows.isEmpty {
    DisclosureGroup("Live Shows (\(artist.liveShows.count))") {
        ForEach(artist.liveShows) { show in
            LiveShowRow(show: show)
        }
    }
}
```

### Chrome Extension

Add collapsible live shows section to popup, similar to web app.

---

## Implementation Phases

### Phase 1: Backend Integration
- [ ] Create `search-bandsintown.ts` Netlify function
- [ ] Add TypeScript types
- [ ] Add error handling and rate limiting
- [ ] Test with various artist names

### Phase 2: Web App UI
- [ ] Create `LiveShowsSection` React component
- [ ] Add to `ResultCard` component
- [ ] Style for light/dark mode
- [ ] Add loading states

### Phase 3: Mac App
- [ ] Add `LiveShowResult` Swift model
- [ ] Update `ArtistResult` to include live shows
- [ ] Create `LiveShowRow` SwiftUI view
- [ ] Integrate into results view

### Phase 4: Chrome Extension
- [ ] Add live shows section to popup
- [ ] Update content script if needed

### Phase 5: Polish
- [ ] Add "View all on Bandsintown" link
- [ ] Implement ticket status badges (available/sold out)
- [ ] Add date formatting (relative dates)
- [ ] Consider geolocation for nearby shows

---

## Edge Cases & Error Handling

| Scenario | Handling |
|----------|----------|
| Artist not found on Bandsintown | Hide "Live Shows" section entirely |
| No upcoming events | Show "No upcoming shows" message with Bandsintown link |
| API rate limited | Cache results, show cached data |
| Ticket link unavailable | Show "Notify Me" button instead |
| API timeout | Show error state with retry option |

---

## Caching Strategy

- Cache artist event data for **1 hour** (events don't change frequently)
- Use artist name (normalized) as cache key
- Store in memory or Redis depending on scale

---

## Analytics & Tracking

Track these events for understanding usage:
- `live_shows_viewed` - User expanded live shows section
- `ticket_link_clicked` - User clicked ticket URL
- `bandsintown_link_clicked` - User clicked "View all" link

---

## Open Questions

1. **Rate limits**: What are Bandsintown's actual rate limits? Need to confirm during API access request.

2. **Commercial terms**: Are there restrictions on how we display the data? Attribution requirements?

3. **Geolocation**: Should we prioritize shows near the user's location? Would need location permission.

4. **Saved Artists**: Should we proactively fetch/notify about new shows for saved artists?

5. **Alternative APIs**: If Bandsintown access is denied, consider:
   - Songkick API
   - Ticketmaster Discovery API
   - SeatGeek API

---

## Resources

- [Bandsintown API Documentation](https://help.artists.bandsintown.com/en/articles/9186477-api-documentation)
- [Bandsintown Public API Info](https://publicapis.io/bandsintown-api)
- [Postman Collection](https://www.postman.com/bandsintowndev/bandsintown-api/overview)
- [API Status Page](http://status.bandsintown.com)
