---
status: Deferred
---
# Unstream Unwrapped — the end-of-year recap

**Written:** 2026-11-19
**Status:** **Deferred to the 2027 season** (Brandon, 2026-11-19). The audience numbers in §9 are
too small for a year-end campaign to be worth building this year: fewer than 15 people would get a
useful recap. **Only §4's play and click logging was built now** (§4.0 says what shipped and where it
differs from the plan below), so next year's recap has a year of counts to start from. Everything
else here is the plan to pick up in autumn 2027, after re-running §9's numbers. Mockups:
[`unwrapped-mockups/`](unwrapped-mockups/README.md).
**Name (decided 2026-11-19):** the feature is **Unwrapped** ("Unstream Unwrapped 2026"). Inside it,
the headline is "Your 2026 in support".
**Builds on:** [artist-patronage-spec.md](artist-patronage-spec.md) §3.7 ("Year in support", which
this replaces), [library-support-scan.md](library-support-scan.md) (the names-in, matches-out,
store-nothing pattern), [support-loop-spec.md](support-loop-spec.md) ("the gap"),
[data-collection-audit.md](data-collection-audit.md) (what we may collect and where it is written down).

---

## 1. The idea

Spotify Wrapped tells you what you consumed. This tells you who you could still back, and asks you
to do something about it before the year ends.

Three parts, in this order:

1. **The recap** — a short, honest look back: artists you saved, artists you supported, what you
   tipped and bought, and (where the apps counted them) who you played most.
2. **The list** — artists you showed interest in and haven't supported yet, limited to those with a
   direct way to pay them.
3. **The pledge** — pick a budget, pick artists, commit to doing it by 31 December. Unstream keeps the
   checklist and reminds you, and never touches the money.

The pledge is the point. The recap exists to earn it.

## 2. Calendar

| Date | What |
|---|---|
| Thu 19 Nov | This spec |
| **Fri 27 Nov** | Extension (Chrome + Firefox) and Mac app releases submitted: play and click logging, the entry point (hidden until the server says so) |
| **Tue 1 Dec** | Web page live, flag on, entry points light up |
| ~3 Dec | Spotify Wrapped usually lands. Ride the conversation, don't compete with it |
| **Fri 4 Dec** | Bandcamp Friday — the first "do it now" reminder, and the best day to act on a pledge |
| ~15 Dec | Mid-month nudge |
| 28 Dec | Last call |
| 31 Dec | Pledge deadline |
| 15 Jan | Entry points go dark; pledges and the page stay readable |

Store review is the long pole. Chrome usually clears in one to three days and AMO is similar; Sparkle
is instant. Submitting on the 27th leaves slack for one rejection.

## 3. What "artists you haven't supported" means

**Decided 2026-11-19 (Brandon):** base the list on artists you **saved** or **clicked a link for**,
not on listening history scraped from Spotify or Apple Music. Interest you showed *in Unstream* is a
better proxy for "would support" than raw plays, which were shown to be noisy when tested against a
real library (Raffi, sleep noise, an artist's own old alias; see `library-support-scan.md`).

Plays come back in as a third signal, from Unstream's own apps (§4), not from exports.

### Candidates

```
candidates  =  saved artists  ∪  artists whose link you clicked  ∪  artists the apps counted plays for
the list    =  candidates
               − marked supported         (saved_artists.supported)
               − tipped through Unstream  (tip_payments, succeeded, livemode, this fan)
               − bought on Bandcamp       (collection_items, where connected)
               − dismissed                (permanent, per §5)
               − no direct-support link   (needs a marketplace, patronage or decentralized link,
                                           per CATEGORY_ORDER; suppressed and 404-marked links don't count)
```

Every row says **why it's there**: "Saved in March · Opened Bandcamp twice · 41 plays". No signal is
hidden, so nothing feels like surveillance.

**Ranking:** plays first, then clicks, then how recently it was saved. Ties go to the artist with the
higher payout to the artist.

### The click problem, and why it's useful

A click on a Bandcamp link might *be* the purchase. So a clicked-but-not-supported artist is not
assumed unsupported; the recap asks:

> You opened 6 artists' Bandcamp or Mirlo pages this year. Did you buy anything?

One tap per artist: **Yes, I bought something** marks them supported (and they count in the recap),
**Not yet** puts them on the list. This fills in a year of support history people never recorded,
and it makes the recap more generous, which is the right direction for its tone.

### What's available for 2026

| Signal | History available for 2026 | Where it lives |
|---|---|---|
| Saved artists | **The whole year** (`saved_artists.added_at`) | Server (Unwrapped needs sign-in, §5) |
| Marked supported | The whole year (`supported_at`) | Server |
| Tips | Since tips opened | Server |
| Bandcamp purchases | Where the import recorded a date | Server |
| Clicks | **From the 27 Nov release only** | On device (§4) |
| Plays | **From the 27 Nov release only** | On device (§4) |

The 2026 edition is therefore mostly saved artists, with a month of clicks and plays. The recap says
so plainly ("Play counts started on 27 November — next year's will cover the whole year") rather than
presenting five weeks as a year. 2027 gets the full picture.

## 4. Play and click logging in the apps

### 4.0 What was built on 2026-11-19

The log in §4.1, counted on the device, with an off switch, and nothing else. Specifically:

- **Extension:** `lib/listening-log.js` (pure, tested by
  `apps/web/tests/unit/extension-listening-log.test.ts`); the service worker counts plays from
  `MUSIC_DETECTED` / `MUSIC_STOPPED` and clicks from the popup's result links, through one queue so
  the log has a single writer. Settings tab: "Play Counts" switch (off deletes), a summary line and a
  Clear button. A one-time notice on the Discover tab links to the switch.
- **Mac app:** `Models/ListeningLog.swift` (the log and the play rule, tested by
  `UnstreamTests/ListeningLogTests.swift`, the same cases as the extension's) and
  `Platform/macOS/PlayCountStore.swift` (fed by `MediaObserver` in `UnstreamApp.swift`, clicks from
  `AppState.trackLinkClick`; JSON in Application Support). Settings → General: "Count plays on this
  Mac" (off deletes), a summary and Clear. A one-time notice in the popover.
- **Disclosures:** the privacy policy's "Play counts" paragraph, a line in the Terms, and
  `data-collection-audit.md`'s "Client-side only" section.

**Differences from the plan below:**

- **One play rule in both clients: 30 seconds of playback**, measured when the track changes or
  stops, instead of the Mac using the half-or-4-minutes scrobble rule. Neither client needs a timer,
  the counts mean the same thing in both, and the extension can't know durations anyway.
- **The web app logs no clicks.** Only the two apps count; §4.2's web `localStorage` log waits for
  the recap that would read it.
- **No handoff, no `/api/unwrapped/resolve`, no recap.** Nothing reads the log off the device, so
  the store listings' data-use answers don't change yet. §4.3–4.5 apply when the recap is built.
- **No confirmation before deleting** when the switch goes off: Firefox popups can't show
  `confirm()`, so the setting's description says it deletes, in both clients.

### Principles

- **On the device, and nowhere else.** No account needed, no server table, no sync.
- **Counts, not history.** Per artist, per month: a play count and a click count. No track titles,
  albums, timestamps or sources.
- **Leaves the device only when you open your recap**, and then only as the top artists for the year
  (§4.3), to a page that stores nothing.
- **Visible and erasable.** A setting to turn it off and a button to clear it, in both apps.

### 4.1 The log

The same shape in both apps, so the web page reads one format:

```json
{
  "v": 1,
  "months": {
    "2026-12": {
      "black country, new road": { "name": "Black Country, New Road", "plays": 41, "clicks": 2 }
    }
  }
}
```

- Key: the artist name lowercased and trimmed. Keep the display name from the first sighting.
- Months older than 24 are pruned on write. At most 2,000 artists per month (drop the lowest counts).
- **Extension:** `chrome.storage.local`, key `listeningLog`, written from the service worker (one
  writer, so no races between tabs). New module `lib/listening-log.js`, unit-tested like
  `search-tracking.js`.
- **Mac app:** a JSON file in Application Support (not UserDefaults, which isn't for growing data,
  and not iCloud). New `ListeningLog.swift` beside `ScrobbleManager.swift`, XCTest-covered. macOS
  only: iOS can't see other apps' playback.

### 4.2 What counts

- **A play** is a track that was playing for at least 30 seconds before the next track started or
  playback stopped, in both clients (§4.0). A track counted in the last 10 minutes isn't counted
  again, so a pause and resume is one play.
- **A click** is opening any platform link for an artist from the popup, the result rows, or the
  now-playing card. The web app logs its own clicks in `localStorage` (same shape, key
  `unstream.listeningLog`), next to the existing anonymous `platform_click` event. Nothing about the
  anonymous analytics changes.

### 4.3 Handing it to the web page

The entry point in each app builds the year's top 200 artists by plays + clicks, then opens:

```
https://unstream.stream/unwrapped/2026#log=<base64url(gzip(json))>
```

- A URL **fragment** is never sent to a server, so it never reaches Netlify's logs, our functions or
  GoatCounter. 200 artists is roughly 5 KB, well inside URL limits. `CompressionStream` exists in
  every browser the extension supports; the Mac app uses `NSData` compression.
- The page reads the fragment, then clears it with `history.replaceState` so it doesn't sit in
  browser history or a copied link.
- It keeps the log in `localStorage` keyed by source (`mac`, `extension`, `web`), so opening from both
  apps merges their counts in that browser. "Forget my play counts" on the page clears them.
- Unwrapped needs sign-in (§5). Because the log is in `localStorage` before the sign-in prompt, it
  survives the magic-link round trip, even when the link opens in a new tab.
- **Sentry:** the client `beforeSend` already strips query strings; it must strip the fragment too.
- To match the names to artist pages, the page sends **names only** to `POST /api/unwrapped/resolve` (§7),
  which stores nothing — the library-support-scan pattern.

**Why not sync it to the server instead?** A server copy would merge devices and let reminder emails
mention plays, but it creates a new kind of identified data (what you listen to, tied to your email)
for a feature that works without it. Start local; add an opt-in sync only if people ask for it
(§10, open question 1).

### 4.4 On by default, and easy to opt out of

**Decided 2026-11-19:** on by default, with a real opt-out. It never leaves the device unless the
person opens their recap, and an opt-in counter would be empty by December. Opting out is possible in
three places, and each one is honoured everywhere the log is read:

1. **The Mac app's settings** (Listening → "Count plays and link clicks on this Mac") and **the
   extension's settings** ("Count plays and link clicks in this browser"). Turning it off stops
   counting *and* deletes what's stored, after a confirmation that says so. Turning it back on starts
   from zero.
2. **The first-run notice.** The first popover or popup open after updating shows one line, "Unstream
   now counts plays on this device for your year-end recap", with a "Turn off" link that goes
   straight to (1).
3. **On the recap itself.** A "Leave out play counts" switch on the cover. It drops the handed-over
   log for this recap and clears it from the browser. It doesn't change the app setting; the page
   says where that lives.

An opted-out app opens Unwrapped with no fragment, so the page cannot tell "opted out" from "never
installed". That is deliberate: the page never needs to know why there are no play counts.

The release notes say all of this. The extension's store listing gets a sentence in its description.

### 4.5 Disclosures to update in the same PR

- `data-collection-audit.md`, "Client-side only": the log, its shape, retention, when it leaves.
- `PrivacyPolicyPage.tsx`: the matching sentence.
- Chrome Web Store and AMO data-use declarations: names sent to `/api/unwrapped/resolve` count as data
  leaving the device, even unstored. Re-check the "User activity" answer before submitting.
- Mac `PrivacyInfo.xcprivacy`: no change expected (nothing is collected off-device by default), but
  confirm.

## 5. The experience

A sequence of full-screen cards on the web, then a working page. Mockups:
the "Unstream Unwrapped mockups" canvas.

**Sign-in required (decided 2026-11-19).** `/unwrapped/2026` asks a signed-out visitor to sign in (magic
link) before showing anything. A play log handed over by an app is kept in `localStorage` through
that round trip (§4.3). Unwrapped is private unless the fan shares it (below).

1. **Cover.** "Unwrapped 2026 · Your 2026 in support." Says what it's built from ("your 23 saved
   artists, plus play counts from your Mac since 27 November") and has the "Leave out play counts"
   switch when a log is present (§4.4).
2. **What you did.** Artists saved · artists supported · tips · records bought. Generous framing:
   any support counts, including the click follow-through answers.
3. **Who you played** (only with play counts). Top five, with play counts and the
   since-27-November note.
4. **Did you buy anything?** The click follow-through (§3). Only when there are clicked artists.
5. **The turn.** "12 artists you saved or played have a direct way to support them."
   The list, with the reason on each row and a dismiss on each row.
6. **Your budget.** $20 / $50 / $100 / custom. Unstream proposes how it could go: one concrete action
   per artist, using catalogue prices where `release_offers` has them ("*Ants From Up There* on Bandcamp,
   $10"), a tip where the artist takes Unstream tips, otherwise their top direct-support link. The fan
   picks; **nothing is pre-ticked** (inferred data stays out of deliberate lists).
7. **Commit.** Saves the plan. The fan is already signed in.
8. **The plan.** A checklist with a progress bar and a countdown to 31 December. Each item links out.
   **Ticking one saves the artist (if not already saved) and marks them supported (decided
   2026-11-19).** Saving subscribes the fan to release alerts, so the first tick says so in one line
   beside the checkbox. An Unstream tip ticks itself; a Bandcamp collection sync that finds the
   artist ticks itself.
9. **Share.** Two ways, both opt-in:
   - **Share image.** "I'm backing 5 artists before the year is out." Artist names, no amounts.
     Drawn client-side and downloaded; nothing is published.
   - **Public page** at `/u/{handle}/2026`, behind a "Share publicly" switch on the plan page. It
     shows the artists you're backing, which are backed, and links to each artist. It never shows
     amounts, play counts, clicks or your budget. It needs a username, and the switch walks you
     through picking one if you haven't. It is independent of your saved-artists list's own sharing
     setting: sharing Unwrapped doesn't publish your saved list, and the reverse. Switching it off
     takes the page down at once (the edge function reads the flag every request; no CDN caching of a
     personal page).

### Three shapes, depending on what there is to show

**Decided 2026-11-19:** without play counts, Unwrapped gets shorter rather than padded. The page
picks a shape from what it has:

| Shape | When | Cards |
|---|---|---|
| **Full** | Play counts handed over, and at least one saved or played artist with a direct-support link | All of 1–9 |
| **No play counts** | No log (opted out, no app, or "Leave out play counts" on) | 1, 2, 4 (if clicks), 5, 6–9. No "who you played". The list's reasons are saves and clicks only. The cover says nothing about play counts beyond a one-line "Play counts are off" when the fan came from an app with them switched off on the page. |
| **Starter** | Fewer than 2 saved artists and no play counts (most accounts: see §9) | 1, then "Start your list": search and save a few artists right there (save = the normal saved-artist path, with release alerts), plus artists the fan clicked on this browser if any. Then 6–9 as usual. No "what you did" card; a stats card with 0s and 1s reads as a scolding. |

The "what you did" card hides any row that is zero, rather than showing "0 tips".

When the list ends up empty (everyone they saved is already supported), the turn card celebrates
that instead and offers the starter's "find more artists" search.

### Tone

Celebratory, never guilt. The list is "who you could back", not "who you owe". Dismiss is permanent
and silent. Completion is self-reported and taken at its word. The share image and the public page
say "backing" and "backed", never "bought", because only `purchased` claims are ever public.

### Money

The budget is a **plan, not a payment**. Unstream never collects a budget and splits it: that is
pooling, which is money transmission (`artist-patronage-spec.md` §2). Each item is the fan paying one
artist directly, through the artist's own link or an Unstream tip. A single checkout that pays the
whole budget at once is what "the tab" (patronage Phase 3) would do, and it stays out of scope here.

## 6. Surfaces — every client gets a way in

| Client | Entry point | During December | Opens |
|---|---|---|---|
| **Web** | Header item and home-page banner, 1 Dec–15 Jan; signed-out visitors see "Sign in to see who you could back this year" | Plan progress in the account menu | `/unwrapped/2026` |
| **Mac app** | Card in the popover's empty state; "Unwrapped 2026…" in the app menu | "On your list" badge on the now-playing card when the playing artist is in your plan; Bandcamp Friday banner links to the plan | Browser, with the log in the fragment |
| **Extension** | Card at the top of the popup | Same badge on now playing; Bandcamp Friday banner links to the plan | New tab, with the log in the fragment |
| **iOS** | None in v1 | — | — |

- **Visibility is the server's call** (the rule in `apps/web/CLAUDE.md`, "Feature flags"). The
  apps call `GET /api/unwrapped/summary` → `{ available, year }`, which reads a new `unwrapped` flag
  and fails closed. The apps ship with the entry point hidden and it appears when the flag flips,
  so the store releases can go out before the page is ready.
- The "On your list" badge needs the plan: `GET /api/me/unwrapped/2026` with the app's existing session.
  Fan endpoints already accept a first-factor session for the apps. **This is v1.1**, not 1 December.
- iOS is out: it has no play log, and App Review's rules on paying third parties (patronage spec §7)
  make a pledge flow there a review risk for little gain.

## 7. Build

### Data

One migration, `YYYYMMDDHHMMSS_year-plans.sql`, both tables **server-only** (RLS on, no policies,
comment saying so), matching how account tables have worked since
`20261003120000_close-direct-account-table-writes.sql`.

```
year_plans
  user_id        uuid → auth.users on delete cascade
  year           smallint
  budget_cents   integer null check (>= 0)
  committed_at   timestamptz not null default now()
  is_public      boolean not null default false   -- the "Share publicly" switch (§5)
  primary key (user_id, year)

year_plan_items
  user_id        uuid → auth.users on delete cascade
  year           smallint
  artist_id      uuid → artists on delete cascade
  action         text check (in ('buy', 'tip', 'support'))
  planned_cents  integer null
  url            text null            -- the link the plan suggested; validated host
  done_at        timestamptz null
  done_by        text null check (in ('fan', 'tip', 'bandcamp'))
  primary key (user_id, year, artist_id)

year_dismissals
  user_id, artist_id  primary key; created_at
```

Dismissals are not per-year: dismissing an artist from your list is permanent, per the support-loop
decision.

### Functions

| Function | Route | Auth | Does |
|---|---|---|---|
| `unwrapped-summary.ts` | `GET /api/unwrapped/summary` | Public | `{ available, year }` from the flag. Cached at the CDN for 5 minutes. |
| `unwrapped-resolve.ts` | `POST /api/unwrapped/resolve` | Public, `strict` limiter | `{ artists: [{ name }] }` (≤ 300) → artist pages with direct-support links, payout, image, a suggested action and price. **Stores nothing**, logs no names. Chunked `.in()`, `readAllPages`. Shares its resolver with the library support scan. |
| `me-unwrapped.ts` | `GET/PUT /api/me/unwrapped/{year}` | Bearer, `account` limiter | The signed-in recap (saved, supported, tips, Bandcamp), the plan, ticking items, dismissals. Ticking an item sets `saved_artists.supported` (saving the artist first if needed, which the fan sees and agrees to: it subscribes them to release alerts). |

All three go through the `endpoint()` wrapper, into `api/tsconfig.json`, with tests in
`api/functions/__tests__/`.

### The public page

`/u/{handle}/2026`, rendered by the `u-handle` edge function as **pure SSR for everyone**, the
release page's shape: nothing on it is interactive, so nothing hydrates and the SPA never claims the
route (one route, one renderer). It reads the plan through a service-role query that returns only
artist names, slugs, images and backed/next-up, and 404s unless `is_public` is true. Every
interpolation goes through `escapeHtml`; the `og:image` is the same layout as the share image,
rendered at the edge. `Cache-Control: private, no-store`, so switching sharing off takes effect on
the next request. Tests: the 404 when private, and an XSS case with a hostile artist name.

### Reminders

Resend, through the existing notification path and `email_log`, behind a new
`unwrappedReminders` preference (on for anyone who committed, one click off):
Bandcamp Friday (4 Dec), mid-December, 28 December. Each lists only the unticked items. Sent from a
GitHub Actions cron like `recatalog-sweep.yml`.

### Web

- `UnwrappedPage.tsx` at `/unwrapped/:year`, lazy-loaded. SPA-only: no edge function renders it, so
  one route has one renderer.
- Cards are components under `components/unwrapped/`; share image drawn to a canvas client-side.
- `services/listening-log.ts`: read/merge/clear the local log; parse the fragment.

## 8. Phasing

- **v1 — 1 December:** log in both apps with all three opt-outs, entry points, sign-in, the three
  shapes, click follow-through, budget and plan, ticking (with save), share image, flag.
- **v1.1 — by Bandcamp Friday (4 Dec) if possible, else mid-December:** the public page, reminder
  emails, "On your list" badges, Bandcamp Friday banner link, the artist kit (§9).
- **Later, if wanted:** Last.fm / ListenBrainz as optional extra sources for people who already
  scrobble; opt-in server sync of the play log; "the tab" so a budget can be paid in one go.

## 9. Who this is for today: the numbers (2026-11-19)

Read-only aggregate queries against production, so the launch is sized to the audience that exists.
Saved-artist counts exclude tombstoned rows. "Direct link" means a marketplace, patronage or
decentralized link.

| Accounts | |
|---|---|
| Total accounts | 210 (200 email-confirmed) |
| Accounts that own a claimed artist profile | **172** (82%) |
| Accounts that are neither a saver nor an artist | 29 |
| Signed in during the last 30 / 90 days | 28 / 45 |

| Saved artists, among the 29 accounts that saved any | |
|---|---|
| Saved 1+ / 2+ / 5+ / 10+ / 25+ | 29 / **13** / 8 / 4 / 1 |
| Median / mean | **1** / 4.6 (a long tail: p75 5, p90 11, max 35) |
| Total saved rows | 132 |
| Savers who are also artists | 20 of 29 |
| Savers signed in during the last 90 days | 11 |
| Have 1+ saved, unsupported artist with a direct link | 21 |
| Have 3+ of those (enough for a real list) | **7** |
| Marked anyone supported | 8 (51 marks) |

| Other signals | |
|---|---|
| Live tips, all time | 3, from 2 signed-in fans |
| Bandcamp collections connected | 8 |
| Public saved-artist lists | 7 of 18 usernames |
| Opted out of release emails | 2 |
| Average daily sessions, last 30 days (anonymous `app_events`) | web ~300 · extension ~31 · Mac ~3 |
| Platform-link clicks, last 30 days | web 173 · extension 8 · Mac 8 |

**What this means:**

- **Fewer than 15 people would get a full Unwrapped today.** About 7 have a real list. Most accounts
  are artists, not fans. So Unwrapped's first job is turning visitors into savers, which is why the
  starter shape (§5) matters more than the full one this year.
- **The anonymous web audience (~300 sessions a day, almost none signed in) is the opportunity.**
  Sign-in being required means the entry point on the web has to sell the account: "Sign in to see
  who you could back this year", not a silent redirect.
- **Play counts will be thin in 2026.** The extension averages ~31 sessions a day and the Mac app ~3.
  The no-play-counts shape is what most people will actually see. That's fine, and it's the reason
  that shape gets a proper design rather than an error state.

### The launch emails

- **No "your Unwrapped is ready" blast to all accounts.** 172 of 210 are artists, and only 13 people
  have saved two or more artists. A blast would mostly send empty recaps.
- **Fans with 2+ saved artists (13 people): a personal note** through Resend. It's small enough to
  write by hand, and they're the people most likely to commit. They're signed up for release alerts,
  but this isn't a release alert, so it needs a one-off preference check. Honour the 2 release-email
  opt-outs as a proxy.
- **Artists (172 accounts): an artist kit.** This is the biggest lever. Artists have the audiences
  that Unstream doesn't. One email: "Fans are making year-end support plans on Unstream. Here's a
  link and an image to ask yours to put you on theirs", with a deep link that opens Unwrapped with
  that artist pre-suggested (not pre-ticked). It needs an artist-facing email preference; the
  existing `weekly_analytics_recap` toggle is the nearest, and the sender is paused. Decide before
  sending.
- **Everyone else: the Buttondown newsletter and social posts** on 1 December, then again on
  Bandcamp Friday.

## 10. Decisions and open questions

**Decided (Brandon, 2026-11-19):**

1. **Name:** Unwrapped. "Your 2026 in support" stays as the headline inside it.
2. **Play counting is on by default, with a real opt-out** in three places (§4.4). Without play
   counts, Unwrapped gets shorter, not padded (§5, "Three shapes").
3. **Sign-in required.** The fan can optionally share Unwrapped publicly (§5, step 9).
4. **Ticking an artist saves them** (and marks them supported).
5. **Launch email:** decided by the numbers (§9). No blast. A hand-written note to the 13 fans, an
   artist kit, the newsletter.

**Open:**

1. **Server sync of the play log** for people with several devices: not in v1. Revisit in January
   with whatever feedback arrives.
2. **Artist kit email preference:** reuse an existing toggle or add an "Unstream news for artists"
   one? Adding one is cleaner and is a one-line migration.
3. **Public page and saved-list sharing:** kept independent (§5). Confirm.

## 11. Repo touchpoints

| Concern | Where |
|---|---|
| Migration | `supabase/migrations/` — `year_plans`, `year_plan_items`, `year_dismissals` |
| Functions | `api/functions/unwrapped-summary.ts`, `unwrapped-resolve.ts`, `me-unwrapped.ts`; flag in `feature-flags.ts`; routes in `netlify.toml` before the SPA catch-all |
| Resolver | Shared with `library-support-scan.md`'s endpoint; `resolveArtistPages` in `collection-utils.ts`; `CATEGORY_ORDER` in `api/shared/platform-registry.ts` |
| Web | `UnwrappedPage.tsx`, `components/unwrapped/`, `services/listening-log.ts`, `main.tsx` route, `Header.tsx` entry point, Sentry `beforeSend` fragment strip |
| Extension | `lib/listening-log.js` (+ test), `background/service-worker.js` (write on detection and click), `popup/` (card, badge, settings toggle), both manifests' versions |
| Mac app | `ListeningLog.swift` (+ XCTest), `MediaObserver`/`ScrobbleManager` hook, `PopoverView.swift` card, app menu item, `SettingsView.swift` toggle and clear |
| Emails | Reminder templates through `notifications.ts`; `NotificationPreferences.tsx` toggle |
| Disclosures | `data-collection-audit.md`, `PrivacyPolicyPage.tsx`, store listings' data-use answers |
