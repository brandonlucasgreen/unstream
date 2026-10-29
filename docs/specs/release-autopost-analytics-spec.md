# Release autopost analytics: how each release is doing, not how each post did

**Status:** proposed 2026-10-29 (Brandon). The second milestone on top of `release-autopost-spec.md`. Nothing is built. The only part of it that has to be built in the first milestone is Buffer's read scope (see "What the first milestone builds for this").

## The idea

Buffer reports engagement **per post, per network**: this Threads post got 7 likes, that Instagram post reached 3 people. That's how a social media manager thinks. An artist thinks in **releases**: is anyone paying attention to the new EP? Does the old album still find people? Is it worth posting about Bandcamp Friday?

Unstream knows which release every autopost and campaign post is about. So it can do what Buffer can't: **add up every post about a release, across every network, into one line per release**, and the same by kind of post and by campaign.

## What artists see

A **"How it's going"** section on the Promote tab, under "Coming up", headed **"Last 30 days"**. An info tooltip beside it reads: "These numbers come from each network through Buffer, and can be up to a day behind."

**One row per release,** with the most engaged first:

| Release | Posts | Total likes | Total comments | Total shares | Threads views | Instagram views |
|---|---|---|---|---|---|---|
| *Lantern* (new) | 6 | 58 | 4 | 7 | 820 | 390 |
| *Halflight* | 2 | 12 | 0 | 1 | 300 | — |

Tapping a release opens its posts: each one's date, network, kind and numbers, with a link to the live post.

Under the table:

- **What kind of post works:** the average per post for each kind (catalogue, pre-order, out now, Bandcamp Friday, support, campaign). This tells the artist whether the back catalogue is worth posting about. It answers the same question for us.
- **Each campaign:** its steps' totals together, so a launch can be judged as a whole.

**Honest with small numbers.** Most indie artists' posts get single figures. Show raw counts, with a per-post average beside each total (a release posted about six times shouldn't win just for that). Show no up and down arrows or percentages.

## Totals, and numbers that belong to one network

Each network reports a different set of metrics. This is what Buffer's API returned for posts on Brandon's Cult of Lightbulbs channels on 2026-10-29:

| Network | Metrics |
|---|---|
| Instagram | reactions, comments, shares, saves, views, reach, follows, engagement rate |
| Threads | reactions, comments, reposts, quotes, views, engagement rate |
| Bluesky | reactions, comments, reposts |
| LinkedIn | reactions, comments |

Facebook and Mastodon weren't in that sample; check them before building.

**The rule (Brandon, 2026-10-29): a metric every network reports is added up and labelled "Total". Anything else is shown per network and labelled with the network's name** ("Threads views", "Instagram saves"). That way a number is never a sum that quietly leaves a network out.

- **Total likes** = `reactions`. **Total comments** = `comments`. Every network has both.
- **Total shares** = `shares` + `reposts` + `quotes`, which are the same act ("passed it on") under three names. It's a total only while every one of the artist's networks reports one of them. Otherwise it becomes per network too.
- **Per network:** `views` (Instagram, Threads), `saves`, `follows` and `reach` (Instagram). Views on two networks sit side by side and are never added together. `reach` counts unique people, so even one network's reach is summed only across that network's posts, as an approximation, and the column says so.
- **Not shown in the table:** `engagementRate`, a ratio. It appears on the per-post view only.
- **Columns follow the artist's own networks.** An artist posting only to Bluesky and Threads sees no Instagram columns.

A metric a network doesn't report is **missing, not zero** ("—"), everywhere.

## How it works: read live, store nothing

**The numbers are fetched from Buffer when the artist opens the section, and nothing is stored.** Thirty days of posts fits in one or two Buffer requests, and that window is all the section shows. So there are no snapshots to keep fresh, no sweep step, and no metrics table to grow.

`GET /api/artist-promote/stats?artist={slug}`:

1. **Check ownership** (the verified claim's `user_id`), as every Promote endpoint does.
2. **One paged `posts` query** to the artist's Buffer organization: their ticked channels, status sent, sent in the last 30 days, with metrics, 100 a page.
3. **Match each post to a release** through `release_autopost_posts.buffer_post_ids`, which already records what was pushed. Instagram posts carry no URL, so the stored ids are the only reliable way to match those.
4. **Add up** with one pure function, `releaseTotals(posts, rows)`. Its tests pin: totals only for metrics every network reports, labels by network otherwise, missing never counted as zero, and shares as one column.

**Failures:** a Buffer error is reported to Sentry and the section says "Couldn't reach Buffer just now", never a table of zeros. A dead grant shows the same reconnect prompt as the rest of the tab.

**A post deleted in Buffer** simply isn't returned, so it drops out of the totals.

**No caching to start with.** The section is opened rarely, and Buffer's limits (about 1,500 requests per 15 minutes per account) leave plenty of room. If it's slow, cache each artist's response for an hour in Postgres, not Redis, since every Redis command is metered.

## The artist's own posts (Brandon's URL idea)

Unstream knows which release each of *its own* posts is about, so those need no URL matching. URL matching earns its place for **the posts the artist writes themselves.** Buffer brings those in too: Brandon's Threads posts written in the Threads app came back from the API with `via: "network"`. Adding them gives the whole picture of a release, not just Unstream's part of it.

- **Which posts:** the same query's other results, those on the artist's ticked channels that Unstream didn't push. No second request is needed.
- **What matches:** a URL in the text that, normalized (no scheme, `www.`, query or trailing slash), equals one of the release's own: its release page, or one of its `release_sources` URLs (the Bandcamp album, Mirlo, Faircamp, Jam.coop). **Only exact URLs.** A post naming the title without a link isn't matched. It's the same under-match-never-over-match rule as release dedup: a wrong match tells the artist a release did something it didn't.
- **Shown apart:** each release gets an "Autopost" line and a "Your posts" line, so the artist can compare them.
- **Nothing is kept.** Posts are matched in memory on each request and never stored, matched or not.
- **Asked for:** setup says it plainly, with its own switch: "Unstream reads your recent posts on these channels to find the ones about your releases."

## What the first milestone builds for this

**Buffer's read scope, asked for when the artist first connects,** alongside `posts:write`, `account:read` and `offline_access`. Adding a scope later would send every connected artist back through Buffer's consent screen. Check the scope's exact name (presumably `posts:read`) before building. Nothing else is needed: `release_autopost_posts.buffer_post_ids` already records what each post was about.

## Build plan

1. **The section for Unstream's own posts,** Brandon only, once Kid Lightbulbs has a few weeks of autopost behind it.
2. **The artist's own posts,** by URL. Second, because it's the only part that reads posts Unstream didn't write, and the part with the most ways to mismatch.
3. **The five test artists** from milestone 1 get the section. Watch whether they open it.

## Check before building

- **The read scope's name,** and whether metrics need anything beyond it.
- **Per-post metrics on Buffer's free plan** through the API. Buffer's aggregated metrics on the free plan only go back 31 days, which this fits. If per-post metrics are paid-only, though, this is a feature for paying Buffer customers, which changes who it's for.
- **Facebook and Mastodon's metric sets,** which decide whether shares stay a total.
- **Which networks bring in posts written outside Buffer** (`via: "network"`). That decides how complete "Your posts" can be.
- **The GraphQL field names** for metrics in a `posts` query (the MCP tools show `metrics { type name value unit }` and `metricsUpdatedAt`).

## Known limitation: clicks

**Clicks aren't counted** (Brandon, 2026-10-29: a known limitation, not a problem for now). No network reports link clicks to Buffer, and the release page loads no script, so nothing sees a fan tap through. A like is attention; a click toward Bandcamp is a fan on their way to paying, so this is the first thing to revisit. Two ways to do it, for later:

- **A `ping` attribute on the release page's buy links** (`<a href="…" ping="/api/release-click?r={id}&p=bandcamp">`). The browser reports each click itself, with no script, so the page stays one renderer and its cached HTML stays the same for everyone. It counts clicks from every visit, not just from posts, and gives the by-platform view ("38 went to Bandcamp, 3 to Mirlo"). Firefox doesn't send pings by default, so the count is "at least". CSP's `connect-src 'self'` already allows it.
- **Short links** (`unstream.stream/r/{code}`, a new redirect per post) would count clicks per post and per network. It's more to build, and fans would see a code rather than the release page's address.

## Later

- **History beyond 30 days,** by storing a daily snapshot of each post's numbers, if artists ask for it.
- **Feed the numbers back into the rotation:** post more about the releases fans respond to. It would stay deterministic only if those numbers were stored, and it would make "Coming up" change from day to day. Decide once there's data showing it would help.
- **A monthly email** with the month's numbers. The paused weekly recap's plumbing exists.

## Open questions

1. **Should the artist's own posts count at all,** or does reading posts Unstream didn't write feel like too much, even with its own switch?
2. **Sort order:** by total likes, or by posts' average? A total favours releases posted about most, which autopost already decides.
