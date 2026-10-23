# Bandcamp blocks Cloudflare Workers: what depends on it, and the options

**Date:** 2026-10-23
**Status:** Resolved by not moving (Brandon, 2026-10-23). Unstream stays on Netlify; see
`hosting-contingency-plans.md`. Kept as the record of what was found and why each option was
weighed.

## What happens

Every Bandcamp *page* a Cloudflare Worker requests comes back as Bandcamp's **"Client Challenge"**:
a ~3 KB page with a `200 OK` status that asks the visitor to run a JavaScript proof-of-work. Code
can't run it, so the fetch gets no data. Found on staging, then confirmed with a throwaway Worker
on Cloudflare's network (`wrangler dev --remote`, never deployed):

| Request from a Worker | Result |
|---|---|
| `<artist>.bandcamp.com/`, `/music`, `/album/…`, `/sitemap.xml` | challenge |
| `bandcamp.com/EmbeddedPlayer/…`, `daily.bandcamp.com` | challenge |
| `bandcamp.com/api/discover/1/discover_web` (robots-allowed) | challenge |
| `bandcamp.com/robots.txt`, `<artist>.bandcamp.com/robots.txt` | real |
| `bandcamp.com/api/subsonic/…` (fans' collection API) | real |
| `f4.bcbits.com` (Bandcamp's image CDN) | real |

The same page requests from a Mac, and from Netlify (AWS), get real pages, **including with an
honest `Unstream/1.0 (+https://unstream.stream)` user agent**. So the block depends on where a
request comes from, not on what it calls itself.

**Who blocks:** Bandcamp's CDN, Fastly (`via: 1.1 varnish`, `x-served-by: cache-…`, `x-timer`). It
is the same wall as `bandcamp.com/search`. Cloudflare is only the outer hop.

**Why Workers:** Cloudflare adds `Cf-Worker: <zone>`, `Cdn-Loop: cloudflare` and `Cf-Ray` to every
outgoing Worker request (seen on an echo server), and they can't be removed. The traffic also
comes from Cloudflare's own addresses. Either is enough for a bot rule.

**No sanctioned route:** Bandcamp's API (bandcamp.com/developer) is for labels and merch-fulfilment
partners only (sales reports, merch orders), by request. It has no artist or release lookup.
`/api/` is otherwise `Disallow`ed in robots.txt, so Bandcamp's undocumented app API is off limits by
our own rule (CLAUDE.md, "Respect other people's servers").

## What fetches Bandcamp pages, and what breaks without it

| # | Feature | Code | When it runs | Without Bandcamp pages |
|---|---|---|---|---|
| 1 | **Find a new artist's Bandcamp by name** (the probe), plus their location and Bandcamp bio | `api/search/bandcamp-probe.ts` via `search-sources.ts`, `collection-matching.ts`, `enrichment.ts` | Live, on a search miss; after a Bandcamp collection import | **New artists lose their Bandcamp link.** The verdict is `undecided`, never cached, reported to Sentry, so nothing is poisoned. Artists already in `bandcamp_slug_probes` are unaffected. |
| 2 | **Featured release and release titles on search cards**; they also *verify* the card | `getBandcampLatestRelease`, `getBandcampReleaseTitles` in `search-sources.ts` | Live, every search with a Bandcamp result | **Bandcamp-only artists show "Unverified"**, with no featured release. Unverified cards fall back to a save key that can collide with another artist's (the Honeycrush double-save). |
| 3 | **Bandcamp catalogue crawl**: release pages, release alerts, calendar/RSS feeds, collection linking, prices | `catalogBandcamp` + `catalogDetails` in `catalog-artist-background.ts` | Queue, after a save/claim/admin request and the 12-hourly sweep | Bandcamp releases stop being added or refreshed. Discogs, Mirlo, Faircamp and Jam.coop keep working. A drop to 0 is reported to Sentry, and stored rows aren't wiped. |
| 4 | **Repair a deleted artist photo** | `refreshDeadArtistPhoto` (reuses #3's page) | Inside #3 | Stops with #3. |
| 5 | **Release check for never-catalogued artists** (Mac app and extension, older builds) | `checkBandcamp` in `check-releases.ts` | Live, only when the catalogue has nothing for that artist | That artist reports no Bandcamp release. |
| 6 | **Play a Bandcamp preview on a search card** | `embed-bandcamp.ts`, used by `ResultCardPreview.tsx` | On click | The preview fails. |
| 7 | **Claim flow**: verify-link check when the artist's site *is* their Bandcamp; avatar from Bandcamp | `scrapeWebsite`, `scrapeAvatarFromPlatform` in `claim-artist.ts` | On a claim | Falls to manual review; no avatar suggestion. |

**Not affected:** Bandcamp collection sync and cover art (Subsonic API, image CDN); artist photos
already stored (image CDN); every Bandcamp link a fan clicks (their own browser).

## Options

**Off the table: defeating the challenge.** That means running its JavaScript in a headless browser
(including Cloudflare's Browser Rendering), renting residential proxies, or disguising requests as a
browser. It is evasion of a site's bot protection. It breaks "respect other people's servers". And
it is an arms race the site wins.

### A. Cut what isn't worth keeping (do regardless)

- **#4 photo repair:** cut. It depends on #3's page anyway, and claimed artists can upload a photo.
- **#5 live release check:** answer from the catalogue only. For an uncatalogued artist, say "not
  catalogued yet" (the response can already carry a null) and queue a catalogue request.
- **#6 search-card preview:** serve it from the catalogue. `release_sources.external_id` already holds
  Bandcamp item ids for catalogued artists, which is all the player needs. Otherwise hide the button.
- **#7 claim scrapes:** drop the Bandcamp avatar suggestion. A Bandcamp-hosted verify link goes to
  manual review, which the flow already has.
- The probe's location and bio (part of #1) come along with whatever replaces #1.

That leaves three things worth solving: **#1 discovery, #2 card data, #3 the catalogue.**

### B. Rely on what's already stored (do regardless)

For artists Unstream already knows, the data is in the database:
- `bandcamp_slug_probes` holds probe outcomes;
- `releases` / `release_sources` hold catalogued discographies.

Have #2 read the catalogue first (featured release, titles), and fetch live only on a miss.
Measured 2026-10-23: about 44% of artists that searches found were already held. This shrinks the
live need; it doesn't remove it, because new artists are exactly what search is for.

### C. Keep the Bandcamp fetching on Netlify (no new box)

Move everything else to Cloudflare, and keep one or two Netlify functions whose only job is
fetching Bandcamp pages for the Worker. They use the same parsers, with the shared secret already in
place. The catalogue crawl's Bandcamp step runs there too, as a background function, as today.

- **For:** known to work today; free on the legacy plan; little new code; no new machine.
- **Against:** Netlify (VC-backed, AWS) stays for the most important platform, so the independence
  goal is only partly met. It adds a hop (~100–300 ms) to Bandcamp lookups. Bandcamp could start
  challenging AWS too; the probe already reports challenges to Sentry, so we'd know quickly.

### D. Run the catalogue on the Mac Studio (no new box)

Phase 4 already puts a CI runner on the Mac Studio. Run the Bandcamp catalogue pass (#3) there as a
scheduled job writing to Supabase, at the same pace and with an honest user agent.

- **For:** no Netlify for the catalogue; the Mac is already in the plan.
- **Against:** it stops when the Mac sleeps, and it doesn't help live search (#1, #2). Running a
  crawler from a home connection because data-centre traffic is challenged is close to the line.
  Acceptable only with an honest user agent, robots.txt respected, and the current polite pace.

### E. Ask to be let in (do regardless; expect nothing)

Brandon writes to Bandcamp. The ask:
- allow requests carrying `Cf-Worker: unstream.stream` (Cloudflare sets it; nobody else can set it
  to our zone);
- at our current pace, artist pages and `/music` only, robots.txt respected.

Fastly's and Cloudflare's "verified bot" programmes need dedicated IPs or reverse DNS, which Workers
can't offer, so they're not a route.

### F. Stay on Netlify (the pause, indefinitely)

It costs nothing on the legacy plan, and everything works. But nothing about the independence goal
moves, and Netlify could end the legacy plan.

## Recommendation (for Brandon to decide)

1. **Do A and B now, on Netlify.** They're improvements on their own: fewer outbound requests,
   faster cards for known artists, and no dead features. They're also needed for every route below.
2. **Then C for #1–#3:** Cloudflare for everything else, Netlify only for Bandcamp page fetches.
   It's the only option that keeps Bandcamp discovery working with no new machine.
3. **Optionally D later**, to move the catalogue off Netlify once the Mac runner exists, leaving
   Netlify with live lookups only.
4. **Revisit E** if Bandcamp ever answers; with their allowance, C goes away entirely.
