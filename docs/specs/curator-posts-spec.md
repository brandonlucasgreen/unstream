# Curator posts: tag the artists you champion

**Status:** proposed 2026-10-21, as Brandon's Buffer Commit hackathon entry. Nothing is built. "Build plan" lists the order to build it in, starting with checking the open questions. The UI mockup is the "Unstream curator posts" design canvas (see "UI").

## Who it's for

People who post about *other people's* music: small labels, radio shows and DJs, zines, record shops, playlist curators. Not artists promoting themselves.

That line is deliberate. Artists are wary of automating their own social media (the anti-AI stance, and fair enough), so anything that writes in an artist's voice is out. Curators are different. Their copy is their own, but the mechanical part of every post is a chore: finding each artist's handle, the right Bandcamp (not the namesake's), and a link that pays the artist.

What artists get is the thing that has actually worked for Unstream's own account: **being tagged by someone who chose their music.** From March to September 2026, every follow Unstream's Instagram earned and every post that reached more than ~10 accounts came from tagging an indie artist who then reshared it (`instagram-original-posts-spec.md`).

## Considered and dropped

| Idea | Why not |
|---|---|
| Auto-announce an artist's own releases to their socials | Artists already run their own profiles; Unstream finds releases only after they're live; and it's lead gen for Buffer more than value for artists. |
| Drop "things worth saying" into the artist's Buffer Ideas board | Buffer may remove Ideas, and it still asks artists to sign up for a tool they may not want. |
| Credit the music on Buffer users' Reels (first comment naming the track's artist) | Most Reels use trending audio, which serves the algorithm, not artists looking for support. The API can't comment after publishing, so Share Now would be missed. And it would need a Buffer API change, which is a feature pitch, not a hackathon entry. |
| Curator list pages | Buy Music Club already does this (Avalon Emerson, since 2018: Bandcamp lists from DJs and labels), and Bandcamp has collections and Clubs. A list page survives below only as a later add-on. |

**How this differs:** Buy Music Club is somewhere people have to go. This puts the post into the feeds curators already use, tags every artist, and covers Mirlo, Subvert, Faircamp, Ampwall and the rest, with each platform's payout.

## Networks: Instagram and Facebook

Both take images and text, both are where curators post, and both work well through Buffer's API. TikTok and YouTube need video, which Unstream can't make, so they're out of scope.

Buffer's free plan allows three channels, which covers one Instagram and one Facebook page.

## The flow

1. **Connect Buffer** (once). Unstream lists the account's Instagram and Facebook channels and the curator ticks the ones it may post to.
2. **Pick a template.** One of the defaults, or one the curator saved (see "Templates").
3. **Add artists as mentions.** Typing `@` searches Unstream's stored artists (the `/api/suggest` typeahead) and falls back to a full search when nothing stored matches. Picking a result inserts a chip tied to that artist's id, optionally with a release. The curator confirms every match, so nothing is guessed. **Paste a list** turns each pasted line into a mention waiting for confirmation, for the 20-artist radio show.
4. **Preview each channel.** One tab per channel, rendered from the template exactly as it will post: caption, cards, tags, character count. Each chip shows its handle on that network, or a "no handle" warning with an "add one" field (see "Handles").
5. **Send.** Share now, add to queue, a set time, or save as a draft in Buffer. The confirmation links to the posts in Buffer.

Unstream creates the posts, so Share Now works the same as scheduling. Nothing listens for posts or polls a queue.

## Templates

A template is two pieces of text the curator writes once:

- **Post:** the wrapper, e.g. `Tonight on {show}:\n\n{artists}\n\nBuy direct, not stream: {link}`
- **Line:** repeated once per mention, joined into `{artists}`, e.g. `{artist} – {release}`

Variables are only facts Unstream already holds. **Unstream writes no copy.**

| Variable | Value | When missing |
|---|---|---|
| `{artist}` | The artist's handle on *this* network, else their name | Their name |
| `{release}` | The release picked in the mention, else their latest catalogued release | Dropped along with the separator before it (" – ") |
| `{payout}` | "keeps 80–85% on Bandcamp", from `platform-registry.ts`, using the artist's best platform | Dropped |
| `{location}` | The artist's location | Dropped |
| `{link}` | One artist: `unstream.stream/a/{slug}`. Several: see "Links" | Never missing |
| `{show}`, `{label}` | The curator's own name for their show or label, set once | Left out of the default templates until set |

**Defaults,** drawn from the copy in `scripts/social-post-templates.ts` and its rules: **Tonight's show**, **New on the label**, **Roster roundup**, **Bandcamp Friday**. The Bandcamp Friday template knows the next date and says Bandcamp's cut is waived that day.

**Hashtags:** at most three, and never `#newmusic` or `#newrelease`. Those were wrong for 72 of 75 prominent posts and brought in the bot comments. The defaults carry none; curators add their own.

## Handles

Unstream only knows the social links that MusicBrainz, the artist's Bandcamp or website, or a claimed profile (~140 artists) supplied. In the 791 pre-generated artist files, a best case since they're the prominent Wikidata artists:

| Network | Artists with a link |
|---|---|
| Facebook | 564 (71%) |
| Instagram | 493 (62%) |

Indie artists will do worse. Run this read-only query in the Supabase SQL editor for production's numbers:

```sql
select a.match_confidence,
  count(distinct a.id) as artists,
  count(distinct a.id) filter (where l.platform = 'instagram') as instagram,
  count(distinct a.id) filter (where l.platform = 'facebook')  as facebook
from artists a
left join artist_links l on l.artist_id = a.id
group by 1 order by 2 desc;
```

Rules:

- **A handle comes only from the artist's own link for that network.** Never derive one network's handle from another's. A handle Threads couldn't resolve, taken from an Instagram link, was the bug behind the existing Threads rule.
- **A missing handle is the normal case, not an error.** The preview offers "add their Instagram". The curator's handle goes into **their own address book** (`curator_handles`). It's used for their posts only and never written to `artist_links`: a handle typed by a stranger is unverified, however plausible it looks.
- The address book is what makes the second post fast. Radio shows and labels mention the same artists again and again.

## What goes to Buffer

**One content item per post,** with one post per selected channel, tagged `unstream: curator`. Instagram is created on its own and then added to the item with `addPostToContentItem`, as `generate-social-posts.ts` does. A content item is all-or-nothing, and a rejected Instagram variant would otherwise sink the Facebook post too.

**Instagram**
- A carousel: a cover card, then one card per artist, up to Instagram's 10 through Buffer. A post with more than nine artists offers to split.
- Cards are drawn by the existing renderer (`scripts/social-card-render.ts`): dark ground, accent kicker, display name, payout panel. The kicker is the curator's (`TONIGHT ON NIGHT SHIFT`) and the footer reads `via @curator · unstream.stream`. Cards Unstream draws count as original content to Instagram; press photos alone don't.
- Tagging: `assets[].image.metadata.userTags`. On a carousel, **the first image's tags apply to every slide** (checked 2026-10-01), so all known artist handles go on the cover card, each at its own position. Caption `@handles` notify too.
- No clickable links on Instagram, so `{link}` becomes "link in bio" or "search them on unstream.stream".

**Facebook**
- The same cards with the caption, and a clickable `{link}`.
- Tagging is unverified. An `@handle` typed in a Facebook caption tags nobody. Buffer's `metadata.facebook.annotations` (text, indices, url) look like how Page mentions work. If they don't, Facebook gets names and links, with no tags.

**Cards are drawn when the curator sends.** The compose function draws each card (~130ms of CPU each, fine in a Netlify Function, too slow for an edge function), uploads it to R2 under a content-hashed key, fetches it back as a PNG, and only then hands Buffer the URL, the same check the weekly generator makes. A card that won't draw is dropped with a visible warning, never sent blank.

## Links

- **One artist:** `unstream.stream/a/{slug}`. It lists every place to buy with its payout, which is the point.
- **Several artists, for the hackathon:** Facebook gets one link per artist in the caption. Instagram says "every artist's links: unstream.stream/u/{curator}". The curator's `/u/` page already exists.
- **Later:** a page for each post at `/u/{handle}/l/{slug}`, listing the artists with their buy links. It follows the existing `u-handle` split: crawlers get HTML from the edge function, browsers get the SPA.

## Backend

**Buffer auth.** OAuth if Unstream can register a client (see "Open questions"). Otherwise the curator pastes a personal API key from Buffer's Settings → API. Either way, the token is encrypted with `credential-crypto.ts` (as for Bandcamp credentials) in `buffer_connections` (`user_id`, encrypted token, organization id, selected channel ids). Server-only: RLS on, no policies, with a comment saying the missing policies are deliberate.

**Tables.** New migration, `IF NOT EXISTS` guards, RLS owner-only:
- `curator_templates`: `user_id`, `name`, `post_text`, `line_text`, timestamps.
- `curator_handles`: `user_id`, `artist_id`, `network`, `handle`, unique on (`user_id`, `artist_id`, `network`).
- `curator_profile` fields (`show_name`, `label_name`) as columns on the existing per-user settings, not a new table, if they fit there.

**Functions.** Each goes through `resolveAccountRequest`, exports through `withSentry`, is listed in `api/tsconfig.json`'s include, and has a test in `__tests__/`:
- `me-buffer.ts`: connect, disconnect, list channels.
- `me-curator-templates.ts`: CRUD on templates and the address book.
- `curator-compose.ts`: `preview` (renders every variant; no Buffer call, no cards drawn) and `send`.

**Send rebuilds everything server-side** from artist ids, the template and the address book. Handles, links, payouts and cards never come from the browser. The template text is the curator's own, so it's sent as written, length-checked against Buffer's `configuration` rules for each service.

**Outbound:** add `api.buffer.com` to `ALLOWED_OUTBOUND_HOSTNAMES`. Every Buffer call goes to that fixed host, so no `safeFetch` is needed. Card images still go through `isCardImageHost` as they do now.

**R2 from a function.** Today only the weekly GitHub Action holds the cards bucket's credentials. The function needs its own token, scoped to that bucket, set in Netlify.

**Budgets.**
- Mentions search stored artists first. A full search spends the `strict` rate limit (10 a minute, 500 a day), which paces a 20-line paste.
- A mention never triggers cataloguing. Search was cut off from triggering it for disk I/O reasons, and a curator's list would be the same mistake one step removed.
- No new Redis use beyond the rate limits.

## UI

Mockup: the "Unstream curator posts" design canvas (https://claude.ai/artifact/VRfB79Cqx7ixg1ByoU7hFP, private to Brandon). Its first version was too text-heavy, and the revision sets the direction: **controls and the preview, almost no explanatory copy.**

- **Compose (`/curator/new`).**
  - **Top row:** the title, the template as a dropdown pill (links to the template editor), and the channels as icons.
  - **Left column:** a search box (with a paste-a-list icon), then one compact row per artist: image, name, release in small grey, payout figure, and an Instagram and a Facebook circle. Teal means the handle is known and the artist will be tagged. A dashed yellow outline means it's missing; clicking it adds one.
  - **Right column:** Instagram/Facebook tabs; the cover card large, with its tags drawn on; the caption collapsed to one line; and a split send button (share now, queue, schedule, draft).
  - No status sentences and no checklist. The circles already say who gets tagged.
- **Template editor:** name, Post, Each artist, Hashtags (up to 3), with clickable variable chips under the Post field and a filled-in sample beside it.
- **Connect:** "Buffer connected" plus a checklist of the account's channels. Instagram and Facebook can be ticked; every other network shows "Not supported yet".
- **Sent:** one row per channel with a "View post" link, and three result tiles (reach, artist page visits, clicks to buy) left empty until there's data.
- **Cards:** the existing card style (`scripts/social-card-render.ts`). The cover card has kicker, title, and one row per artist with tag bubbles; each artist card has kicker, name, location, payout panel and the release.

## Hackathon cut

**No migrations.** `npm run dev` runs against production Supabase, and a migration applied from an unmerged branch blocks every later migration on `main` (see "Database / migrations" in `CLAUDE.md`). So the hackathon build stores nothing new:

1. **Buffer access from env vars, admin only.** `BUFFER_CURATOR_ACCESS_TOKEN` and `BUFFER_CURATOR_ORG_ID`, gated to `ADMIN_EMAIL` the way tips are (`canSetUpTips`). No connect screen yet: channels come from Buffer's `channels` query.
2. **One built-in template** ("Tonight's show"), editable in the page for that post only. Saving templates comes later.
3. **Mentions** via `/api/suggest`, which only finds stored artists; no paste-a-list.
4. **Instagram and Facebook previews,** cards drawn, tags on the cover card.
5. **Share now, or save as a Buffer draft.**
6. **Missing handles** can be typed in for this post only.

Demo: pick "Tonight's show", mention five artists, add one missing Instagram handle, watch both previews fill, Share Now, then open the posts in Buffer.

## Build plan

For a local Claude Code session on this branch (`spec/curator-posts`). Read `CLAUDE.md` first: the `npm run dev` traps (the empty-`.env` shadow, worktrees serving the main checkout's functions) all apply.

**0. Before writing code: check the unknowns with Buffer drafts.** These decide parts of steps 4–5.
- Instagram: create a draft carousel on the `kidlightbulbs` channel (Cult of Lightbulbs org) with `userTags` for two real handles and one that doesn't exist. Note whether Buffer accepts it and what it does with the bad handle.
- Facebook: create a draft on the Kid Lightbulbs page with `metadata.facebook.annotations` for a Page mention. Note whether it tags.
- Delete both drafts afterwards. Record what you found in "Open questions".

**1. Buffer client: `api/functions/buffer-client.ts`.**
- A small GraphQL `fetch` wrapper for `https://api.buffer.com`, modelled on `bufferGraphQL` in `scripts/generate-social-posts.ts`. Add `api.buffer.com` to `ALLOWED_OUTBOUND_HOSTNAMES`.
- Functions: `listChannels(orgId)`, `getServiceLimits(orgId)` (the `configuration` query's `LengthRule`s), `createPost`, `createContentItem`, `addPostToContentItem`, and `ensureTag` (lift the generator's tag logic).
- Test it with a stubbed `fetch`. It's a pure module, so tests are easy.

**2. Rendering: `api/functions/curator-posts.ts`, pure, no I/O.**
- `renderTemplate(template, artists, network, curator)` returns the caption.
- Rules for missing values, per the spec's variables table: `{release}` drops its " – "; `{artist}` falls back to the name; Instagram's `{link}` becomes "link in bio".
- Splits into a thread only where the network supports one. Instagram and Facebook don't, so an over-limit caption is an error the UI shows.
- `handleFor(artist, network, addressBook)`: only the artist's own link for that network, then the curator's entry, then null.
- This is where most tests go. Cover every missing-value case, every network, and the `#newmusic`/`#newrelease` block.

**3. Cards.**
- Add a `cover` slide and a `curator-artist` slide to `scripts/social-card-render.ts` (kicker from the curator's show name; footer `via @handle · unstream.stream`).
- Upload with `publishCard` / `cardKey` from `scripts/social-cards.ts`, using the same fetch-it-back check.
- **Conflict to settle first:** `api/functions/social-card.ts` is scheduled for removal, and its header says to remove `loadCardAssetsWith` with it. But a Netlify Function bundles as CommonJS and needs that same font-loading workaround to render cards. Either keep `loadCardAssetsWith` and change that header, or render cards some other way. Don't silently delete what the new function needs.
- **R2 credentials** (`R2_ACCOUNT_ID`, `SOCIAL_CARDS_R2_ACCESS_KEY_ID`, `SOCIAL_CARDS_R2_SECRET_ACCESS_KEY`, plus the bucket's public URL setting) are only in GitHub secrets today. Add them to the Netlify site, then check they appear in `npm run dev`'s "Injected project settings env vars" line. Buffer has to fetch the cards, so a localhost URL won't work.

**4. Endpoint: `api/functions/curator-compose.ts`.**
- `POST /api/curator/preview` and `POST /api/curator/send`, routed in `netlify.toml`.
- Admin-gated through `authenticateAdmin` for the hackathon. Export through `withSentry`, list the file in `api/tsconfig.json`'s include, and add tests in `__tests__/`.
- The body carries artist ids, an optional release per artist, the post's template text, typed-in handles and the send mode.
- **Everything else is looked up on the server:** artist rows and links through `db.ts`, payouts from `platform-registry.ts`, and handles from the artist's links plus the typed-in ones. Check typed-in handles against Instagram's username format.
- `preview` returns each network's caption, its tags and what's missing, without drawing any cards.
- `send`:
  1. Draws and uploads the cards.
  2. Creates the Instagram post on its own, with tags on the first image.
  3. Creates the Facebook post as a content item.
  4. Adds the Instagram post to that content item.
  5. Tags everything `unstream: curator`.
  6. Returns the posts' Buffer ids and links.
  
  A failed Instagram post must not take the Facebook post down with it.

**5. Page: `apps/web/src/pages/CuratorComposePage.tsx` at `/curator/new`.**
- Lazy-loaded in `main.tsx`, shown only to admins (`AuthContext`'s admin check).
- Build it to the mockup's revised compose screen: the artist rows, the network circles, the preview tabs, the collapsed caption and the split send button.
- The search reuses the header's suggestion component if it fits.
- Preview requests run on a short debounce. The cover card in the page is HTML drawn to look like the real card, not the rendered PNG.

**6. Check.**
- `npm run verify` passes.
- Using `npm run dev`, run Share Now to the Cult of Lightbulbs Instagram and Facebook. They're real channels, so use the draft mode until the tagging behaviour has been seen once.
- Before committing, `git checkout -- deno.lock`, since `npm run dev` rewrites it.

**After the hackathon:** move the Buffer token, templates and address book into tables (the "Backend" section above), in a migration merged to `main` before any branch depends on it. Then OAuth, paste a list, and results.

## Later

Saved templates and the address book; paste a list; a list page per post; OAuth; a "your last posts" panel pulling `aggregatedPostMetrics` for the `unstream: curator` tag, next to Unstream's own count of clicks through to buy pages.

## Open questions

1. **OAuth for third-party apps.** Buffer's docs describe authorization code flow with PKCE and client registration under Settings → API. Two outside reviews in 2026 (Zernio, PostProxy) say third-party clients can't be registered yet. Check internally.
2. **Facebook Page mentions through `annotations`.** Test with a draft post on the Kid Lightbulbs page.
3. **Instagram `userTags` through Buffer:** the most tags one cover card takes, and what happens when a handle doesn't exist. Rejected post, dropped tag, or silent failure? Test with a draft carousel on `kidlightbulbs`.
4. **Production handle coverage.** Run the query above.
5. **Demand.** Ask two or three curators (a college radio show, a small label, a zine) how they post today and whether they'd use this. Brandon's view is that Instagram and Facebook are their main networks.
