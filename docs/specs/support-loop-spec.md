---
status: In progress
---
# The support loop — unified spec

**Written:** 2026-08-09
**Status:** Finalised 2026-08-09. Ready to build from.
**Absorbs:** [collection-spec.md](collection-spec.md) and
[mac-app-premium-spec.md](mac-app-premium-spec.md) — both still hold for their detail; this is the
single plan across them.

---

## 1. One loop, not two goals

The fan collection and the paid Mac app looked like parallel tracks. They're one mechanism:

```
  Mac app watches what you actually play
            ↓
  The gap:  artists you love and have never paid
            ↓
  A purchase  (or a patronage pledge, later)
            ↓
  The collection fills up — evidence, not intent
            ↓
  Someone shares their page
            ↓
  New people arrive → some install the Mac app
            ↓
        (back to the top)
```

Every step already exists in some form except the two that matter: **the gap** and **a page worth
sharing**.

**The weak link is "someone shares their page"** — the only step that depends on a person choosing
to act.

*An earlier draft proposed a Step 0 to test this by checking whether any `/u/` page had ever been
shared externally. **Dropped 2026-08-09** — Brandon: "Nobody has shared anything externally because
I've never really shared that it's possible, and very few non-musicians are using this." A null
result would have been uninformative, which means it wasn't a real test.*

The better evidence is that **the behaviour already exists in the wild**: people post end-of-year
lists and collection screenshots for pride and virtue signalling. Unstream doesn't need to create
that impulse, only to serve it. Existing behaviour elsewhere beats absent behaviour here.

---

## 2. Why Subsonic is Bandcamp-only

Two corrections landed here, in order.

**First:** an early draft claimed self-hosters "have the values and haven't connected them to artist
payment." That's wrong. Someone running Navidrome has *de facto* already made the connection — they
went out of their way to own files. They're converted, not a mind to change. So generic Subsonic was
never conversion; it was habit maintenance for the already-convinced.

**Then:** generic Subsonic was scoped in, and back out again — "too much of a can of worms for now."
Bandcamp plus Apple Music is enough to drive interest.

Bandcamp still uses the Subsonic protocol, so the client is a Subsonic client. It just points at one
known host. What that buys, versus the generic version: no SSRF surface from user-supplied server
URLs, no LAN-reachability problem, no per-server provenance policy, one credential instead of a
connections table.

**The interesting direction that remains unscoped:** getting a once-passive listener to try
self-hosting *for the first time* — Unstream as a gateway into owning rather than a reader of
libraries that already exist. Much bigger ask, not in this plan.
`guides/how-to-build-a-music-library-without-streaming` is the seed.

---

## 3. Decisions locked

| | |
|---|---|
| **Mac distribution** | **Outside the App Store.** Payment via Stripe or Lemon Squeezy. Sparkle for updates. |
| **Sandbox question** | **Moot** — it only mattered for MAS. No longer blocking. |
| **App Store name collision** | Also moot. |
| **Permanent dismissal** | In. A support list you can't prune becomes a guilt machine. |
| **Provenance** | `purchased` / `owned` / `listened`. Only `purchased` is public. |
| **Followers** | Not building. |
| **Spotify import** | Not building — 5-user cap. Spotify listeners are served by ongoing monitoring (Step 5) instead. |
| **Generic Subsonic** | Not building — "too much of a can of worms for now." Bandcamp-only; Funkwhale/Navidrome deferred as a group. |
| **iTunes payout** | Assert no percentage. Show a note instead — see §5. |
| **Free vs paid** | Search, now-playing, support links, saved artists stay free. Paid is listening history and everything derived from it. |

---

## 4. Apple Music is bigger than a source

Brandon's case for pulling it forward: it's #2/#3 in streaming share, every Apple-blog pitch lands
better with it, and **iCloud Music Library already mixes owned and streamed music in one place** —
which is how he uses it personally, and conceptually the same hybrid Unstream is arguing for.

That last point turns out to be technically exploitable. Verified against
`sdef /System/Applications/Music.app` on Brandon's Mac: every track exposes a read-only
**`cloud status`** property (`eClS`) with these values:

`unknown` · **`purchased`** · **`matched`** · **`uploaded`** · `ineligible` · `removed` · `error` ·
`duplicate` · **`subscription`** · `prerelease` · `no longer available` · `not uploaded`

**So an Apple Music library can be read with provenance attached** — you can tell what someone owns
from what they're only renting. Nothing else in the sequence offers that.

### Two consequences

**1. The AppleScript route beats MusicKit.** Reading the local Music.app library via AppleScript
needs no developer token, no Apple Developer Program dependency, and no per-user cap — *and* it
returns richer data than the web API would. It downgrades the `AuthKey_*.p8` question from blocking
to merely interesting. It's also **Mac-app-only**, which makes it a premium feature by nature: "your
library, sorted by what you actually own versus what you're renting" is something the website
physically cannot do.

**2. Map it carefully.** Music.app's `purchased` means *iTunes Store*, which pays through the normal
label and distributor chain — better than a stream, nothing like Bandcamp's 80–85%. Mapping it onto
Unstream's `purchased` tier would overstate support and quietly corrupt the one number the
collection page exists to tell the truth about.

| Music.app `cloud status` | Unstream provenance |
|---|---|
| `matched`, `uploaded` | `owned` — your own file; could be a CD rip *or* a Bandcamp download |
| `purchased` | `owned` — you own a copy, but this is not direct support |
| `subscription` | `listened` |

Worth noting `matched`/`uploaded` means **Bandcamp purchases may be hiding inside the Apple
library** as uploaded files. The Bandcamp import is what identifies those correctly, so the two
sources genuinely complement rather than overlap.

---

## 5. iTunes as a platform

Brandon's proposal: list iTunes as a marketplace with a payout percentage, guessed at 30–50%.

**The guess is in the right zone but the number can't honestly be asserted.** Apple takes **30%**,
leaving 70% to the *rights holder*. What reaches the **artist** depends entirely on the deal:

- Independent, self-released, own distribution → close to the full 70%
- Signed to a label → commonly **10–25% of** that 70%, i.e. roughly 7–17% of the sale price

That's a 10× spread, and nothing in the API tells us which case a given release is.

**This is the Discogs situation exactly**, and the registry already has the right precedent: Discogs
carries no `payoutPercent` because "secondhand pays the artist nothing and new-stock label accounting
is unknowable from the API." Putting a made-up midpoint on iTunes would corrupt the most load-bearing
field in the product — the one the press kit invites journalists to check.

**Recommendation:** add iTunes as a marketplace, ordered below Bandcamp/Mirlo/Ampwall, with **no
asserted payout percentage** and a **required note**:

> Apple keeps 30%. What reaches the artist depends on their label or distributor — an independent
> artist keeps most of the rest; a signed artist may see 10–25% of it.

Silence alone would be misleading in the other direction, implying iTunes is as artist-hostile as
secondhand Discogs, which it isn't. The note is the honest middle.

**Implementation note:** `PlatformMeta.payoutPercent` is a `string`, so a value like `"varies"` would
render, but the badge reads "N% to artist" — asserting "varies to artist" is worse than nothing. This
likely wants a new optional `payoutNote` field rather than abusing the existing one.

**Open question:** is including a big-tech store on-mission at all? Precedent says yes — Qobuz (~70%)
and Beatport (55–70%) are already listed and neither is artist-direct. iTunes sorts below them.

---

## 6. The sequence

Sizes are rough and relative, not estimates. Sequence set by Brandon 2026-08-09: both
imports land before the page rebuild, so the collection page is designed against real libraries of
different shapes rather than one imagined one.

### Step 1 — Bandcamp import · medium

**Scope reversed 2026-08-09.** A generic Subsonic connector was briefly in scope; Brandon scrapped
it — "too much of a can of worms for now." Bandcamp plus Apple Music is enough to drive interest.

Bandcamp-only removes three problems the generic version created:

- **No SSRF surface.** A user-supplied server URL was a textbook SSRF vector against the outbound
  allowlist in `api/functions/middleware.ts`. `bandcamp.com` is a fixed, pinnable host.
- **No reachability problem.** A self-hosted Navidrome on someone's LAN isn't reachable from Netlify;
  Bandcamp is public, so the import can run **server-side**.
- **No per-server provenance policy.** Bandcamp collections are proof of purchase, full stop, so
  everything imported here is `purchased`.

One credential per user, not a connections table.

**Build:** Subsonic client against `https://bandcamp.com/api/subsonic` using the **ID3 endpoints**
(`getArtists`, `getAlbumList2`, `getAlbum`) rather than folder-based ones — better data for a library
import, and it keeps the door open if generic servers ever come back. Credential handling as in
`collection-spec.md` §4: encrypted salted-token, never plaintext, RLS-scoped, disconnect that offers
to delete imported data, never logged to Sentry. Background sync with progress; Bandcamp warns large
libraries are slow in beta.

#### Deferred, not discarded

**Funkwhale, Navidrome, Airsonic, Jellyfin** all speak a subset of the Subsonic API, so if the
generic connector ever returns they come as a group rather than one at a time. Test pod for that day:
`demo.funkwhale.audio`. The client should stay Bandcamp-shaped but not Bandcamp-*hardcoded* — keep
the server URL a constant rather than inlining it everywhere, so this stays cheap.

**Mirlo** is the more interesting near-term addition, per Brandon — an artist-first marketplace whose
values line up, and likely to have a usable API. Worth asking them directly rather than scraping;
`releases-v1-scope` notes Mirlo is robots-blocked, so scraping is off the table anyway.

### Step 2 — Apple Music library import · medium

`sdef` confirms Music.app already exposes, per track: `played count`, `played date`,
`skipped count`, `rating`, `favorited`, `date added`, `location`, and `cloud status`.

**Music.app is already holding years of play history.** That inverts the original plan. Listening
history doesn't need to be *accumulated* before the Support List means anything — for an Apple Music
user it can be *read* on day one, with real historical weight behind it.

So this step alone produces a complete, immediately meaningful list:

> 1,240 tracks · 340 you own · 900 subscription-only · 62 artists you've played more than 20 times
> and never paid.

That kills the cold-start problem, and it's the single fastest path from install to "oh."
`location` being absent corroborates `cloud status` as an owned-vs-streamed signal.

### Step 3 — Collection page rebuild · small

Album-art grid, counts in the header, per-item hide, public/private. It's a UI rebuild of a page
that already exists, and the data now exists to fill it.


### Step 4 — Support List v1 · medium

The UI over Step 2's data: ranked by plays, grouped by genre, filtered by platform, state per row
including permanent dismissal. Bandcamp Friday becomes a filtered view.

### Step 5 — Ongoing listening history · medium

Passive now-playing monitoring, accumulating over time. Two jobs: keep the list fresh, and **serve
the people Step 2 can't reach** — Spotify listeners have no importable library, so ongoing monitoring is
their only route in. Recency weighting comes from here too.

This is coverage work, not initial-value work, which is why it moved last within Step 3.

### Step 6 — Paid gate · small

Lemon Squeezy or Stripe, licence check, Sparkle. Grandfather existing tip-jar payers.

### Step 7 — Press push · low effort, already drafted

See §5 on timing — this is the one real fork in the sequence.

### Step 8 — Last.fm gap on the web · small

Gives non-Mac users a gap report. Broadens the loop past macOS.

### Step 9 — Apple Music on the web via MusicKit · medium, conditional, low priority

Only if `AuthKey_XDBZJJA474.p8` is a live MusicKit key, and only to give non-Mac users a gap report.
The Mac AppleScript route in Step 3 is strictly better data, so this is a breadth play, not a
capability one.

**Why this order:** both import steps land *before* the
page rebuild, so the collection page is designed against several real libraries of different shapes
rather than against one imagined one. Then the paid half, then money, then distribution.

---

## 7. The one real fork: when to pitch

The press kit is live and the pitches are drafted. Sept 4 is a Bandcamp Friday. But the *story*
changes enormously after Step 3.

- **Now:** "a free tool that finds where to buy music." True, decent, unremarkable.
- **After Step 3:** "it quietly remembers what you actually listen to, then tells you which artists
  you love and have never paid." That's a review, not a listing.

**Recommendation: split the pitches.** Spend the cheap ones now, save the marquee one.

- **Now (September):** Verge Installer, Tedium, Waxy. Short-item outlets, low effort, low stakes,
  and they suit the current story fine.
- **Hold for Step 3:** MacStories. It's your best shot and a deep review deserves the better
  product. Pitching it now spends the relationship on the weaker story.

This is the decision I'd most like a reaction to.

---

## 8. Open questions

**Blocking Step 1:**

1. **How is the Bandcamp credential encrypted?** There is **no existing encryption pattern in this
   repo** — Step 1 introduces one, so it's a deliberate decision, not an implementation detail.
   Options: Supabase Vault, `pgcrypto` with a key in env, or app-level Node `crypto` with the key in
   Netlify env. Pick before writing the migration.
2. **How much history does Bandcamp's Subsonic beta actually return?** Test against a real account
   before committing to the sync shape. It's in open beta and Bandcamp warns large libraries are slow.

**Blocking Step 2:**

3. **What is `AuthKey_XDBZJJA474.p8`?** Only matters for Step 9 (MusicKit on the web) — the Step 2
   AppleScript route needs no key at all.
4. **Genre coverage.** MusicBrainz tags are the cleanest source, but check real coverage before
   promising genre grouping in marketing.

**Blocking Step 3:**

5. **Does collection replace saved-artists?** It can't — saved drives release alerts and the feeds.
   So they coexist, and the UI has to make the relationship legible or it will confuse.
6. **Should a Bandcamp import auto-mark the artist "supported"?** True and satisfying; risks
   overwriting a deliberate user distinction.

**Later:**

7. **Price.** ~$15 one-time is the working assumption. Worth asking the two volunteers what they
   pictured.
8. **Mirlo API.** Ask them directly — scraping is off the table, they're robots-blocked.
9. **iTunes `payoutNote` field.** Needs adding to `PlatformMeta` before iTunes can be listed
   honestly — see §5.

---

## 9. Build notes — repo touchpoints for Step 1

Written so a fresh session can start without re-deriving the layout.

| Concern | Where |
|---|---|
| Migration | `supabase/migrations/` — naming is `YYYYMMDDHHMMSS_kebab-name.sql` |
| API function | `api/functions/` — see `me-settings.ts`, `saved-artists.ts` for the auth + RLS shape |
| Route wiring | `netlify.toml` `[[redirects]]` — `/api/x` → `/.netlify/functions/x` |
| Outbound fetch | `api/functions/middleware.ts` — SSRF allowlist; **add `bandcamp.com` deliberately** |
| Settings UI | `apps/web/src/pages/SettingsPage.tsx` |
| Shared fetch | `safe-fetch` module (added in PR #358) |
| Secrets | Netlify env, as `BUTTONDOWN_API_KEY` is handled |

**Conventions worth honouring:** server-side proxying rather than browser-side third-party calls (the
reason `newsletter-subscribe.ts` exists rather than Buttondown's embed); RLS on every user-scoped
table; never log credentials, including Sentry breadcrumbs.

**Related specs:** `collection-spec.md` §4 (Bandcamp connect flow, credential handling) and §5 (data
model, provenance tiers). `mac-app-premium-spec.md` for Steps 2–6.