# Release autopost analytics: how each release is doing, not how each post did

**Status:** proposed 2026-10-29 (Brandon). The second milestone on top of `release-autopost-spec.md`. Nothing is built. Three small things it needs are built in the first milestone, so the history exists from the first post (see "What the first milestone builds for this"). Everything else waits until autopost has been running.

## The idea

Buffer reports engagement **per post, per network**: this Threads post got 7 likes, that Instagram post reached 3 people. That's how a social media manager thinks. An artist thinks in **releases**: is anyone paying attention to the new EP? Does the old album still find people? Is it worth posting about Bandcamp Friday?

Unstream already knows which release every autopost and campaign post is about, and where its link sent people. So it can do something Buffer can't: **add up every post about a release, across every network, into one line per release**, and the same by platform (where the links went), by kind of post and by campaign.

## What artists see

A **"How it's going"** section on the Promote tab, under "Coming up". It covers the last 30 or 90 days, or everything, and is updated daily.

**One row per release,** most clicked first:

| Release | Posts | Clicks | Views | Likes | Comments | Shares |
|---|---|---|---|---|---|---|
| *Lantern* (new) | 6 | 41 | 1,210 | 58 | 4 | 7 |
| *Halflight* | 2 | 9 | 300 | 12 | 0 | 1 |

Tapping a release opens its posts: each one's date, network, kind and numbers, with a link to the live post.

Under the table:

- **Where the clicks went:** Bandcamp 38, the release page 12, Mirlo 3. For the release page, what fans clicked through to from it as well (see "Clicks", step 2).
- **What kind of post works:** the average per post for each kind (catalogue, out now, Bandcamp Friday, support, campaign). This tells the artist whether the back catalogue is worth posting about. It answers the same question for us.
- **Each campaign:** its steps' totals together, so a launch can be judged as a whole.

**Honest with small numbers.** Most indie artists' posts get single figures. Show raw counts, a per-post average beside each total (a release posted about six times shouldn't win just for that), and no up and down arrows or percentages until there are enough posts for them to mean something (at least 5 on each side). Say "updated daily" and say which networks a number comes from.

## Making Buffer's numbers add up

Each network reports a different set of metrics. This is what Buffer's API returned for posts on Brandon's Cult of Lightbulbs channels on 2026-10-29:

| Network | Metrics |
|---|---|
| Instagram | reactions, comments, shares, saves, views, reach, follows, engagement rate |
| Threads | reactions, comments, reposts, quotes, views, engagement rate |
| Bluesky | reactions, comments, reposts |
| LinkedIn | reactions, comments |

Facebook and Mastodon weren't in that sample; check them before building (see "Check before building").

They become five columns by these rules:

- **Likes** = `reactions`. **Comments** = `comments`. Every network has both.
- **Shares** = `shares` + `reposts` + `quotes`. They're the same act ("passed it on") under three names.
- **Views** = `views`, **only from the networks that report it**, labelled with them ("views on Instagram and Threads"). Bluesky has no views. Treating that as zero would make a Bluesky-heavy release look ignored.
- **Not added up:** `reach` counts unique people, and two networks' unique people can't be added together. `engagementRate` is a ratio. `saves` and `follows` are Instagram's alone and appear only on the per-post view.
- **Clicks** come from Unstream, not Buffer (next section).

A metric a network doesn't report is **missing, not zero**, everywhere. That is the same rule the bio and probe caches follow for "didn't answer".

## Clicks: the number that matters, and the one Buffer doesn't have

None of the networks above give Buffer link clicks. A like is attention; a click toward Bandcamp is a fan on their way to paying. That's the number that fits Unstream's mission, so Unstream counts it itself, in two places.

### 1. Short links in posts

Every link autopost writes is a short link, **`unstream.stream/r/{code}`**: one code for each post on each channel, sending people to the destination the link rules already pick (the Bandcamp album, or the release page). A small function, `short-link.ts`, routed at `/r/*`:

- **Looks up the code and answers 302** to its stored destination. The destination is written when the post is pushed and never comes from the request, so this can't become an open redirect. It is always the release page or one of that release's own source URLs.
- **Counts one click** into `release_autopost_link_clicks (code, date, count)` through a `SECURITY DEFINER` increment function. Like every function here, it is revoked from `PUBLIC, anon, authenticated` and called by the service role.
- **Doesn't count crawlers** (`api/shared/crawler-detection.ts`). The networks' link-preview fetchers would otherwise count every post as clicked once. They still get the redirect.
- **Isn't cached** at the CDN, since every click has to reach the function. It uses no Redis: one database read and one write per click.
- **An unknown code** gets the 404 page.

**Why a short link rather than a `?ref=` on the release page:** the release page is cached at the edge by its full URL, and a parameter would split that cache. A short link leaves the release page's URL alone and also measures links that go straight to Bandcamp, which a parameter on our own page never could. As a bonus, it's 25 characters, which helps on Bluesky's 300.

**What it costs the artist:** the post shows `unstream.stream/r/k3x9q2` rather than `kidlightbulbs.bandcamp.com/album/lantern`. Fans can't see where a link goes before tapping it, and every click takes one redirect (tens of milliseconds) longer to get there. The link-preview card should still show the Bandcamp page, since the preview fetchers follow the redirect; check this before building. **This is the one real trade in this spec, and it's Brandon's call** (Open questions 1). The alternative keeps the visible Bandcamp URLs and gets click counts only for posts that link to the release page.

The endpoint is unauthenticated and writes a counter, the same exposure `analytics-event.ts` already has. Someone could inflate an artist's click count, which harms nothing but that artist's chart. It isn't rate-limited, because every Redis command is metered.

**Instagram has no clickable links in posts,** so Instagram rows show no clicks ("link in bio") rather than zero.

### 2. Clicks out of the release page

The release page is pure server-rendered HTML with no script, so today **nothing counts its visits or its outbound clicks**. GoatCounter's script isn't on it either. Each "buy" link on it gets a `ping` attribute: `<a href="…bandcamp…" ping="/api/release-click?r={releaseId}&p=bandcamp">`.

- The browser sends the ping by itself when the link is clicked. No script and no hydration are involved, so the page stays one renderer.
- It counts **every** visit's clicks, not just those from posts. Every claimed artist's release pages get "where fans went from here" for free.
- The ping URL is fixed for each release and platform, so the cached page stays the same for everyone.
- Firefox doesn't send pings by default, so the count is "at least". The UI says so.
- CSP's `connect-src 'self'` already allows same-origin pings.

The counts go into `artist_analytics` as a `release-click:{platform}` metric. They need a release id, so either that table gains a nullable `release_id`, or a small `release_analytics (release_id, date, metric, count)` beside it. Prefer the separate table: the artist dashboard's existing queries stay untouched.

## The artist's own posts (Brandon's URL idea)

Autopost already knows which release each of *its* posts is about, so it needs no URL matching. That's just as well: its Instagram posts have no URL to match. URL matching earns its place for **the posts the artist writes themselves.** Buffer brings those in too: Brandon's Threads posts written in the Threads app came back from the API with `via: "network"`. Adding them gives the artist the whole picture of a release, not just Unstream's part of it.

- **Which posts:** sent posts on the artist's ticked channels without an `unstream:` tag, so autopost posts aren't counted twice.
- **What matches:** a URL in the text that, normalized (no scheme, `www.`, query or trailing slash), equals one of the release's: its release page, a short link, or one of its `release_sources` URLs (the Bandcamp album, Mirlo, Faircamp, Jam.coop). **Only exact URLs.** A post naming the title without a link isn't matched. It's the same under-match-never-over-match rule as release dedup: a wrong match tells the artist a release did something it didn't.
- **Shown apart:** "Your posts" and "Autopost" are separate lines for each release, so the artist can compare them.
- **Stored:** only the matched posts' ids and metrics. The text of posts that didn't match is never kept.
- **Asked for:** setup says it plainly, with its own switch: "Unstream reads your posts on these channels to find the ones about your releases."

## How it runs

**Measuring is a fourth step in `release-autopost-sweep`** (Plan, Push, Tidy, **Measure**). Once a day per artist, it fetches metrics for posts sent in the last 30 days whose snapshot is more than a day old. That's one paged `posts` query filtered to the autopost and campaign tags, with metrics, 100 posts a page, so one or two Buffer calls per artist per day. The artist's own posts (above) are another query of the same size.

- **Metrics refresh daily at Buffer** (`metricsUpdatedAt`), so fetching more often gains nothing.
- **After 30 days a post's numbers are frozen.** Social engagement is nearly all in the first few days, and stopping keeps the number of calls flat as history grows.
- **Snapshots are ours.** Buffer's free plan limits its aggregated metrics to the last 31 days. Storing each post's figures means an artist's history doesn't vanish after a month and doesn't depend on their Buffer plan.
- **A post deleted in Buffer** is marked `deleted` and drops out of the totals. That's also the "do the posts survive" measure in the autopost spec.
- **Failures:** a Buffer error leaves the old snapshot in place, goes to Sentry, and the post is retried next run. A failed fetch is never stored as zeros, which would be caching uncertainty.

### Tables

Server-only like the rest: RLS on, no policies, read through the Promote tab's endpoint after the claim's ownership check, with a comment saying so.

- **`release_autopost_post_metrics`**, one row per Buffer post: `buffer_post_id` (PK), `post_id` (our slot row; null for the artist's own posts), `release_id`, `artist_id`, `channel_id`, `service`, `source` (`autopost` | `campaign` | `own`), `sent_at`, `metrics jsonb` (Buffer's `type → value`, as returned), `metrics_updated_at`, `fetched_at`, `deleted`. Columns are worked out when read, not stored, so changing a rule needs no backfill.
- **`release_autopost_links`**: `code` (PK), `post_id`, `channel_id`, `destination`, `created_at`.
- **`release_autopost_link_clicks`**: `(code, date)` PK, `count`.
- **`release_analytics`**: `(release_id, date, metric)` PK, `count`, for the release-page pings.

The adding up is plain SQL behind one endpoint, `GET /api/artist-promote/stats?artist=…&range=30d`. All the rules above live in one pure function, `releaseTotals(rows, clicks)`, with tests that pin missing-not-zero, shares as one column, and views only where reported.

## What the first milestone builds for this

These have to be there from the first post, or the first months have no numbers. **This is the only change this spec makes to `release-autopost-spec.md`.**

1. **Ask for Buffer's read scope when the artist first connects,** alongside `posts:write`, `account:read` and `offline_access`. Adding a scope later means every connected artist has to go through Buffer's consent screen again. Check the scope's exact name (presumably `posts:read`) before building.
2. **Short links** (`short-link.ts`, `release_autopost_links`, the click counter), so every post ever sent can be counted. The numbers just build up until this milestone shows them.
3. **Store each Buffer post id with its channel and network:** `buffer_post_ids` as `[{ channelId, service, postId }]`, not a bare list.

The release-page pings don't depend on autopost and can ship whenever.

## Build plan

1. **Measure and store** (the sweep step and the metrics table), on Kid Lightbulbs' posts from milestone 1. Then the table on the Promote tab, Brandon only.
2. **Release-page pings,** for every claimed artist's release pages. These are useful even with autopost off.
3. **The artist's own posts,** by URL. Last, because it's the only part that reads posts Unstream didn't write, and the part with the most ways to mismatch.
4. **The five test artists** from milestone 1 get the section, and we watch whether they open it.

## Check before building

- **The read scope's name,** and whether metrics need anything beyond it.
- **Per-post metrics on Buffer's free plan** through the API. If they're paid-only, this is a feature for paying Buffer customers, which changes who it's for.
- **Facebook and Mastodon's metric sets.**
- **Link previews through the short link:** does Buffer's preview (and each network's) follow the 302 and show the Bandcamp card?
- **Which networks bring in natively written posts** (`via: "network"`). That decides how complete "Your posts" can be.
- **The GraphQL field names** for metrics in a `posts` query (the MCP tools show `metrics { type name value unit }` and `metricsUpdatedAt`).

## Later

- **Feed the numbers back into the rotation:** post more often about the releases fans respond to. It would stay deterministic, since the inputs are stored snapshots, but it makes "Coming up" change from day to day. Decide once there's data showing it would help.
- **A monthly email:** "your posts sent 41 people toward Bandcamp this month". The paused weekly recap's plumbing exists.
- **Sales.** Bandcamp's sales API is only available to labels on request. A click is as close as this gets for now.

## Open questions

1. **Short links or visible Bandcamp URLs?** Short links measure every post. Visible URLs are more transparent and save a redirect, but only release-page links can be measured. Recommended: short links. Has to be decided before milestone 1 ships, since the first posts carry whichever it is.
2. **Should the artist's own posts count at all,** or does reading posts Unstream didn't write feel like too much, even with its own switch?
3. **The 30-day freeze:** right for Instagram and Threads. Does anything keep earning after a month (a pinned post)?
