---
status: In progress
---
# Mac app premium — spec

**Written:** 2026-08-09
**Status:** Draft for Brandon's review
**Extends:** [macos-menubar-app-spec.md](macos-menubar-app-spec.md) (the shipped v1)
**Related:** [collection-spec.md](collection-spec.md) — same data, different surface

---

## The bet

Unstream's mission moment happens *inside a streaming app* — hearing someone you like while
scrolling. Only the Mac app and the extension reach it. The Mac app is also the only surface that
can **remember**, because it's the only one that's always running.

That memory is the product. Two people have said they'd pay; the goal is to make it obvious to a few
hundred more.

**Free stays free.** Search, now-playing, support links, saved artists. Nobody is ever charged to
support an artist — that would invert the whole thing. Paid is the *power tooling* on top: the
listening history and everything derived from it. That's precisely what the indie-Mac audience buys.

---

## The core feature: the Support List

Not a Bandcamp Friday feature. A **standing shopping list for supporting music**, which happens to
have a very good day once a month.

The app already watches what's playing. Let it keep score. The list is then derived, continuously:

> Artists you actually listen to, ranked by how much, minus the ones you've already supported.

### A row

| | |
|---|---|
| Artist + art | |
| Why it's here | "47 plays this month · 3 albums in your library" |
| Where to support | Platform chips with payout %, ordered artist-first |
| Genre | For grouping |
| State | `not yet` · `bought` · `patron` · `not interested` |

### Views

- **Ranked** (default) — by plays, recency-weighted so it reflects what you're into *now*
- **By genre** — the thing that makes a 200-row list browsable instead of overwhelming
- **By platform** — "show me only what's on Bandcamp"
- **By state** — what's done, what's outstanding

### Moments

- **Bandcamp Friday** — banner plus an automatic filter to list items available on Bandcamp. The day
  becomes a view of an existing list, not a separate feature.
- **New release from a list artist** — bumps to the top, since that's the natural moment to buy.
- **Monthly recap** — "you played 340 tracks across 62 artists; here are the 5 you love most and
  have never paid." This is the retention hook and the mission statement in one notification.

### State, and where it comes from

- `bought` — set automatically from the Bandcamp collection import, or manually
- `patron` — later, from Unstream patronage once it ships
- `not interested` — permanently dismissed, no nagging. Essential: a list that can't be
  pruned becomes a guilt machine, and guilt doesn't convert.

### Genre data

Available but messy. MusicBrainz tags (already integrated) are the cleanest starting point;
Bandcamp tags are richer but folksonomy-noisy. Suggest MusicBrainz primary, Bandcamp fallback, and
let the user re-tag. **Open question:** worth checking coverage before promising genre grouping in
marketing.

---

## Everything else that's paid

Cheap to build once the listening history exists:

- **Shortcuts actions** — "Get support links for current track", "Add to support list", "What's my
  gap?". This audience automates everything; it's disproportionately loved for the effort.
- **Widget** — outstanding support-list count on the desktop or in Notification Centre.
- **Local-only history** — the history never leaves the device unless the user connects an account.
  A real privacy claim, not a marketing one, and the kind of thing that gets quoted in a review.
- **Export** — CSV/JSON of your list and history. Data ownership is a value this audience holds and
  it costs almost nothing.
- **Collection browsing offline** — once the Bandcamp import exists.

---

## Pricing and distribution

**One-time, around $15, all updates included.** Not a subscription. The audience prefers it, it fits
"we don't nickel-and-dime," and it's consistent with refusing a fan subscription on the web.

### Do not ship this through the Mac App Store

MAS is tempting — it handles payment, VAT, licensing, updates, and adds discovery — but:

1. **Sandboxing.** MAS requires the app sandbox. Now-playing detection reaches into other apps
   (MediaRemote or AppleScript against Spotify/Music), and that's exactly what the sandbox is
   designed to prevent. Many now-playing apps ship outside MAS for this reason. **Verify this before
   anything else** — if now-playing dies under sandboxing, MAS is impossible, not merely awkward.
2. It also moots the App Store name collision, which is a small bonus.

**Recommended stack:** direct download (as today) + a merchant of record like **Paddle** or **Lemon
Squeezy** to handle VAT and licensing, plus **Sparkle** for updates. That's the standard indie Mac
setup and it keeps distribution where it already is.

---

## Why this appeals to that audience specifically

Every item is something MacStories, Six Colors, and their readers reliably care about: native
SwiftUI, menu bar, Shortcuts, widgets, local-first privacy, data export, one-time price, no account
required for the free tier, no AI. It isn't a coincidence — it's the same list the press pitch
leads with, which means the product and the pitch reinforce each other rather than being written
separately.

---

## Phasing

1. **Listening history** — local store, artist-level play counts. Everything depends on it.
2. **Support List v1** — ranked view, state tracking, buy links.
3. **Paid gate + purchase flow** — Paddle/Lemon Squeezy, licence check, Sparkle.
4. **Genre grouping and filters.**
5. **Shortcuts actions, widget, export.**
6. **Monthly recap notification.**
7. **Patronage state** — once patronage ships.

Steps 1–3 are the minimum that's worth charging for.

---

## Open questions

1. **Does now-playing detection survive the App Store sandbox?** Determines distribution. Check
   first.
2. **Retroactive history?** New users start with an empty list, which is a cold start. Connecting
   Last.fm or a Bandcamp collection seeds it immediately — worth pairing the launch with that.
3. **What happens to existing users?** Some paid via the StoreKit tip jar already. They should be
   grandfathered into premium; it's the right thing and it costs nothing.
4. **iOS?** The app is on hold and iOS can't do background now-playing monitoring the same way.
   Suggest Mac-only and say so plainly rather than implying parity.
5. **Is $15 right?** Comparable indie Mac utilities sit at $10–25. Worth asking the two people who
   volunteered what they had in mind.

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
