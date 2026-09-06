---
status: In progress
---
# Collection — spec

**Written:** 2026-08-09
**Status:** Draft for Brandon's review
**Why now:** The word-of-mouth engine is the fan page at `/u/{handle}`, and it can't be pushed
because a saved-artist list is a *wishlist*. People share collections. This turns the page from
intent into evidence.

**Related:** [library-import-spec.md](library-import-spec.md) specs the streaming half for the Mac
app (GH #151) and is still awaiting review — its source ordering is superseded below.
[growth-playbook-2026-08.md](../growth-playbook-2026-08.md) has the strategic context.

---

## 1. What this is

Two halves that are much stronger together:

- **The collection** — releases you actually acquired. Album art, dates, where from. This is the
  public artifact, and the thing worth sharing.
- **The gap** — artists you listen to a lot and have never supported. This is private by default
  and exists to motivate the owner, not to perform for anyone.

The page becomes a story with tension in it: *what I love, what I've actually backed, and the
distance between.* It works on the owner before it works on a reader, and it's never empty, because
an import populates it before the user has bought anything through Unstream.

**Non-goals.** Not a social network — no following, no feeds, no comments (deliberately deferred,
see the growth playbook). Not a player. Not a migration tool; we never write to a connected service.

---

## 2. Source viability — read this before planning anything

The API landscape moved in 2026 and it is not what `library-import-spec.md` assumed.

| Source | Gives you | Viable? | Ceiling |
|---|---|---|---|
| **Bandcamp** (Subsonic) | **Collection** — what you bought | ✅ Best | Open beta; creds not OAuth |
| **Last.fm** | Gap — scrobbles, top artists | ✅ Easy | Public API, no user cap |
| **Apple Music** (MusicKit) | Gap — library + heavy rotation | ✅ Viable | Needs Apple Developer Program |
| **YouTube** (Data API v3) | Gap — partial, low fidelity | ⚠️ Marginal | 100-user cap until OAuth verification |
| **Spotify** (Web API) | Gap — library, top artists | ❌ **Blocked** | **5 users** |
| **Any Subsonic server** | Owned files — Navidrome, Airsonic, Jellyfin | ⏸️ **Deferred** | Scrapped from scope 2026-08-09 |
| **Discogs** | Collection — but secondhand | ⚠️ Weak signal | Proper API |

### Spotify is effectively blocked — this is the headline

As of the February/March 2026 changes:

- New apps in Development Mode are capped at **5 users**, down from 25.
- The app owner must hold an **active Premium subscription** or the app stops working.
- **Extended Quota Mode** — the only way past the cap — accepts applications only from *registered
  organizations with an active service of at least 250k monthly active users*.

Unstream is nowhere near 250k MAU and isn't a registered organization. Existing apps were
grandfathered, but **there are no Spotify credentials anywhere in the repo** — the `resolve-url`
function parses public Spotify pages rather than calling the API. So there's nothing to grandfather.

**Don't build Spotify import.** It would work for five people. This is the single most important
finding in this spec and it inverts the ordering in the old library-import spec, which had Spotify
second.

### YouTube is marginal, and I'd defer it

There is no YouTube *Music* API. The Data API v3 gets you liked **videos** (mixed music and
non-music), channel subscriptions (which need mapping to artists via "topic" channels), and
user playlists. YouTube Music's own library is only partially reflected.

On top of the low fidelity: `youtube.readonly` is a sensitive scope, so an unverified app is capped
at **100 users** until it passes Google's OAuth verification, and the default quota is 10,000
units/day.

Doable, but it's the most work for the noisiest data. Recommend deferring until something else
proves the feature is wanted.

### Subsonic generally — deferred, 2026-08-09

Was in scope briefly, then scrapped: "too much of a can of worms for now." Bandcamp plus Apple Music
is enough to drive interest. Reasoning and what it saves (no SSRF surface, no LAN reachability
problem, no per-server provenance policy) is in `support-loop-spec.md` §2 and Step 1.

Funkwhale, Navidrome, Airsonic and Jellyfin all speak a subset of the Subsonic protocol, so if this
returns they come as a group. Keep the Bandcamp client Subsonic-shaped but not Bandcamp-hardcoded so
that stays cheap. Test pod for that day: `demo.funkwhale.audio`.

### Apple Music is now more viable than Spotify — a reversal

MusicKit needs an Apple Developer Program membership and a token dance (developer token → user
token), which is why it was deferred before. But it has **no per-user cap**, and Brandon appears to
already hold a developer account (`AuthKey_*.p8` in the project directory — confirm what it's for).
That makes it the strongest *streaming* source available.

---

## 3. Phasing

**Phase 1 — Bandcamp collection.** The whole point. Sanctioned API, richest signal, no user cap,
and it alone makes the profile page worth sharing.

**Phase 2 — Profile page rebuild.** The collection needs somewhere good to live. Could ship
alongside Phase 1.

**Phase 3 — Last.fm gap.** Cheapest streaming-side source, no caps, and the audience overlap is
highest.

**Phase 4 — Apple Music gap.** More work, no cap, real audience.

**Deferred:** YouTube (low fidelity, verification hurdle), Discogs (secondhand undercuts the story),
Spotify (blocked).

---

## 4. Bandcamp integration (Phase 1)

### Connect flow

Bandcamp's Subsonic support shipped 2026-07-16 and is in open beta. Server is
`https://bandcamp.com/api/subsonic`; the user generates credentials under **Fan Settings → Subsonic**.

1. `/settings` gains a **Connect Bandcamp** section explaining, in plain words, that this reads the
   collection and never modifies anything.
2. Step-by-step with a deep link to Bandcamp's Fan Settings, since generating credentials is a
   manual step the user has to do on Bandcamp's side.
3. User pastes username + generated credential. We verify immediately with a `ping` call and show
   the collection count as confirmation it worked.
4. Import runs in the background. Bandcamp warns large libraries sync slowly — show progress, don't
   block the UI.

### Credential handling — the part to get right

Subsonic auth is username + token, **not OAuth**. That means Unstream holds credentials to
someone's Bandcamp account, which is a materially higher responsibility than a scoped, revocable
OAuth token.

- Store the salted-token form (`t` + `s`), **never a plaintext password**.
- Encrypt at rest. These do not belong in a plainly-readable column.
- RLS so a user's credentials are readable only by that user's own session.
- A **Disconnect** button that deletes the credential row and, on the same screen, asks whether to
  delete imported collection data too.
- Never log the credential, including in Sentry breadcrumbs.
- State clearly that this is Bandcamp's beta and may break.

### What to read

Subsonic endpoints, paginated: `getAlbumList2` (`type=frequent`/`newest`/`alphabeticalByArtist`)
for the collection, `getStarred2` for favourites if populated. Map each album to an Unstream
release where one exists, and keep the raw Bandcamp identity where it doesn't — an unmatched album
should still appear in the collection rather than vanishing.

---

## 5. Data model

### `collection_items`

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `user_id` | FK, RLS-scoped |
| `release_id` | FK → releases, **nullable** — an unmatched import still shows |
| `source` | `bandcamp` \| `discogs` \| `manual` |
| `external_id` | source's ID, for dedup on re-sync |
| `title`, `artist_name`, `art_url` | denormalised so an unmatched item still renders |
| `acquired_at` | date from source where available |
| `provenance` | `purchased` \| `owned` \| `listened` — see below |
| `acquisition` | `purchased` \| `free` \| `unknown` |
| `hidden` | user can hide an item from the public page |
| `created_at` | |

Unique on `(user_id, source, external_id)` so re-sync updates rather than duplicates.

### Provenance is the load-bearing distinction

Three tiers, and conflating them would gut the product's honesty:

| Tier | Means | Sources | Counts as support? |
|---|---|---|---|
| `purchased` | The artist was paid | Bandcamp, manual entry, Unstream patronage | **Yes** |
| `owned` | You have the file; provenance unknown | Navidrome and other Subsonic servers | No |
| `listened` | Streaming signal only | Last.fm, Apple Music | No |

**Only `purchased` appears on the public collection page.** `owned` and `listened` feed the gap. A
page that counted ripped CDs as support would be lying, and the whole value of the artifact is that
it isn't.

### `listening_signals` (Phase 3+)

`user_id`, `artist_name`, `source`, `play_count`, `last_played`, `synced_at`. Feeds the gap
report. Unique on `(user_id, source, artist_name)`.

### The gap is derived, not stored

`listening_signals` minus artists represented in `collection_items` minus artists marked supported.
Computing it live keeps it honest and avoids a staleness bug.

---

## 6. Profile page rebuild

`/u/{handle}` today is a list of names with small avatars and a few "Supported" badges. That's the
thing to replace.

**Public — the shareable artifact:**

- Header: avatar, handle, location, and three counts — *releases collected*, *artists supported*,
  *platforms used*. Numbers make it feel like a collection rather than a list.
- **Grid of album art.** This is the whole redesign. Art is what makes a page screenshot-able and
  the reason anyone shares it into a Discord.
- Sort by recently acquired, default. Filter by platform.
- Each item links to the release page, so a viewer can buy the same record — the loop closes.
- Empty state points at the import, not at "search for an artist."

**Private — the owner's view only:**

- **The gap.** Artists you play a lot and have never supported, ranked by play count, each with a
  one-click path to the support links.
- Default **private**. Publishing "artists I love but never paid" is a strange flex and reads as a
  callout of the artists. Offer sharing as an explicit opt-in later, if anyone asks.

**Privacy controls:** whole-profile public/private, per-item hide, and a clear statement of what a
visitor can see. Existing `/api/me/saved-artists-sharing` is the precedent to extend.

---

## 7. Open questions for Brandon

1. **What is `AuthKey_XDBZJJA474.p8`?** If that's an active MusicKit key, Apple Music moves up.
2. **Does collection replace saved-artists, or sit beside it?** Saved artists drive release alerts
   and the feeds, so it can't just be deleted. My instinct: *saved* stays as the follow mechanism,
   *collection* becomes the public artifact.
3. **Should an imported Bandcamp album auto-mark that artist "supported"?** It's true and it's
   satisfying. Risk: it overwrites a deliberate user distinction.
4. **How much history does Bandcamp's Subsonic beta actually return?** Needs testing against a real
   account before committing to the phase.
5. **Manual add?** Lets someone record a purchase made at a merch table or a Faircamp site. Cheap,
   and it's the only way to log the most direct support there is.

---

## 8. Risks

- **Bandcamp's beta changes or closes.** Highest-impact risk; the whole phase rests on it. Mitigate
  by storing imported data as our own rather than proxying live.
- **Credential storage.** The one thing here that could genuinely harm a user. Treat accordingly.
- **Empty collections.** If someone connects nothing, the page is as thin as it is today. The gap
  report is the fallback value, which is an argument for pulling Last.fm forward.
- **Scope.** This is four integrations plus a page rebuild. Phase 1 alone — Bandcamp plus the grid —
  is a shippable, self-contained bet, and the rest should wait on whether anyone shares one.

---

## Folded into the unified spec — 2026-08-09

The plan across both halves now lives in [support-loop-spec.md](support-loop-spec.md): one loop
rather than two tracks, with a proposed sequence. This document still holds for its detail.

Two things here are superseded by it:

- **Subsonic-generally is habit maintenance, not conversion.** Someone running Navidrome has already
  connected owning to paying — they're converted, not a mind to change. Its real value is premium
  appeal to the nerdy-hobbyist crowd (who are also the paying crowd) and that it's nearly free once
  the Bandcamp client exists.
- **Mac distribution is decided: outside the App Store**, paid via Stripe or Lemon Squeezy. The
  sandbox question is therefore moot, not open.
