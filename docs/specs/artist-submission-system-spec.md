# Artist Link Submission System - Implementation Spec

## Overview
Allow artists to manually submit and verify their platform links, stored in a database and integrated with search results.

## Database Options

| Option | Pros | Cons |
|--------|------|------|
| **Supabase** (Recommended) | Free tier, Postgres, built-in auth, real-time, easy integration | Requires account setup |
| **PlanetScale** | Free tier, MySQL, good scaling | More complex setup |
| **Netlify Blobs** | Already on Netlify, simple key-value | Not ideal for queries |
| **JSON file in repo** | Simplest | Manual PR workflow, no real-time updates |

## Data Schema (Supabase/Postgres)
```sql
-- Artists table
CREATE TABLE artists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL, -- lowercase, alphanumeric only for matching
  email TEXT, -- for verification
  verified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Artist links
CREATE TABLE artist_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID REFERENCES artists(id),
  platform TEXT NOT NULL, -- 'bandcamp', 'mirlo', 'instagram', etc.
  url TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(artist_id, platform)
);

-- Index for fast search
CREATE INDEX idx_artists_name_normalized ON artists(name_normalized);
```

## Verification Flow Options

### Option A: Email Verification (Simple) - Recommended
1. Artist enters name + email + links
2. We send verification email with magic link
3. Artist clicks link to confirm
4. Links become active

### Option B: Domain Verification (More Secure)
1. Artist enters links to platforms they control
2. We provide a unique code to add to one of their bios (e.g., Bandcamp)
3. Our system checks for the code
4. Links become active

### Option C: OAuth Verification (Most Secure)
1. Artist connects via existing platform (Bandcamp, etc.)
2. We verify they own the account
3. Links become active

## UI Components Needed

### 1. Submission Form (`/submit-artist`)
- Artist name input
- Email input
- Dynamic link inputs (add platform + URL pairs)
- Submit button

### 2. Verification Page (`/verify?token=...`)
- Shows confirmation of verified links
- Allows adding more links after verification

### 3. Search Integration
- Query database alongside MusicBrainz/Discogs
- Merge verified links into results with "Verified by artist" badge

## API Endpoints

```
POST /api/submit-artist
  Body: { name, email, links: [{ platform, url }] }
  Returns: { success, message }

GET /api/verify?token=xxx
  Activates the submission

GET /api/artist-links?query=xxx
  Returns verified links for search integration
```

## Implementation Steps

1. **Set up Supabase** - Create project, tables, indexes
2. **Create submission form** - New React page with form
3. **Build submission API** - Netlify function to insert + send verification email
4. **Build verification API** - Function to mark as verified
5. **Integrate with search** - Query DB in search-sources.ts
6. **Add "Verified" badge** - UI indicator for artist-submitted links

## Cost Estimate
- **Supabase free tier**: 500MB database, 50k monthly active users
- **Email**: Use Netlify Forms notifications or Resend.com free tier (100 emails/day)

## Scope Summary
This is a moderate-sized feature touching:
- New database setup
- 2 new pages (submit, verify)
- 2-3 new API endpoints
- Search integration changes
- Email sending setup
