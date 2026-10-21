# Curator posts: tag the artists you champion

**Status:** proposed 2026-10-21, as Brandon's Buffer Commit hackathon entry. Nothing is built. "Build plan" lists the order to build it in, starting with checking the open questions. The UI mockup is the "Unstream curator posts" design canvas (see "UI").

**Written for the Cloudflare Worker.** This spec assumes Phase 1 of `docs/specs/infrastructure-independence-plan.md` (PR #653) has shipped, so the site runs on one Worker:
- routes live in `workers/routes.ts`, not `netlify.toml`
- secrets are Worker secrets, set with `wrangler secret put`, and `.dev.vars` locally
- local full-stack development is `npm run dev:worker`

Handlers are still Lambda-style modules in `api/functions/` behind `workers/function-adapter.ts`, so everything said here about functions holds.

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
- Cards are drawn by the existing renderer (`scripts/social-card-render.ts`, run in the browser; see below): dark ground, accent kicker, display name, payout panel. The kicker is the curator's (`TONIGHT ON NIGHT SHIFT`) and the footer reads `via @curator · unstream.stream`. Cards Unstream draws count as original content to Instagram; press photos alone don't.
- Tagging: `assets[].image.metadata.userTags`. On a carousel, **the first image's tags apply to every slide** (checked 2026-10-01), so all known artist handles go on the cover card, each at its own position. Caption `@handles` notify too.
- No clickable links on Instagram, so `{link}` becomes "link in bio" or "search them on unstream.stream".

**Facebook**
- The same cards with the caption, and a clickable `{link}`.
- Tagging is unverified. An `@handle` typed in a Facebook caption tags nobody. Buffer's `metadata.facebook.annotations` (text, indices, url) look like how Page mentions work. If they don't, Facebook gets names and links, with no tags.

**Cards are drawn in the curator's browser, with the generator's own renderer.** Phase 0.3 of the infrastructure plan took card drawing out of the app on purpose: ~130ms of CPU a card, plus fonts and resvg's wasm, which a Worker can't read off disk. Putting it back on the server would undo that. Instead:

- **One renderer, two hosts.** `scripts/social-card-render.ts` already draws through `@resvg/resvg-wasm`, which runs in a browser, and already takes its fonts and wasm from a swappable loader. Split it into a platform-neutral core and two asset loaders: the existing Node one (`readFileSync`, for the generator) and a browser one (`fetch` of the same three fonts and the wasm, served as static assets). The generator's cards and the curator's cards then come from the same code.
- **The preview is the real card.** The compose page draws the PNG and shows it, so what the curator sees is exactly what Buffer gets.
- **Loading cost:** the wasm (~2.5 MB) and fonts load only on the compose page, which is lazy-loaded and admin-only during the hackathon.
- **Upload goes through the Worker to R2 by binding.** The page POSTs each PNG to `/api/curator/cards`, which:
  1. checks it is a PNG (magic bytes) of exactly 1080×1350 (IHDR) and under 2 MB;
  2. writes it with an `r2_buckets` binding to the `unstream-social-cards` bucket, under `curator/{user-hash}/{sha256}.png`;
  3. fetches the public URL back, as the generator does, before returning it.
  
  The binding means there are no S3 keys to hold. The server doesn't redraw or vouch for the card's content, which is the curator's own post, but it never accepts anything that isn't a correctly sized PNG.
- **No photos on curator cards for now.** Artist photos and covers live on CDNs (`bcbits.com` and others) that don't send CORS headers, so a browser can't draw them onto a card. The hackathon cards are text-only, matching the mockup. Adding covers later means proxying them through the Worker with the existing `isCardImageHost` check.
- **A card that won't draw blocks sending** with a visible error. It's never sent blank.

## Links

- **One artist:** `unstream.stream/a/{slug}`. It lists every place to buy with its payout, which is the point.
- **Several artists, for the hackathon:** Facebook gets one link per artist in the caption. Instagram says "every artist's links: unstream.stream/u/{curator}". The curator's `/u/` page already exists.
- **Later:** a page for each post at `/u/{handle}/l/{slug}`, listing the artists with their buy links. It follows the existing `u-handle` split: crawlers get the server-rendered page, browsers get the SPA.

## Backend

**Buffer auth.** OAuth if Unstream can register a client (see "Open questions"). Otherwise the curator pastes a personal API key from Buffer's Settings → API. Either way, the token is encrypted with `credential-crypto.ts` (as for Bandcamp credentials) in `buffer_connections` (`user_id`, encrypted token, organization id, selected channel ids). Server-only: RLS on, no policies, with a comment saying the missing policies are deliberate.

**Tables.** New migration, `IF NOT EXISTS` guards, RLS owner-only:
- `curator_templates`: `user_id`, `name`, `post_text`, `line_text`, timestamps.
- `curator_handles`: `user_id`, `artist_id`, `network`, `handle`, unique on (`user_id`, `artist_id`, `network`).
- `curator_profile` fields (`show_name`, `label_name`) as columns on the existing per-user settings, not a new table, if they fit there.

**Functions.** Each goes through `resolveAccountRequest`, exports through `withSentry`, and has a test in `__tests__/`. Each also needs:
- a route in `workers/routes.ts`, which is also what gets it typechecked through `workers/tsconfig.json`;
- an entry in `workers/function-handlers.ts`;
- a line in `api/tsconfig.json`'s include list, for the editor and `typecheck:api`.

The functions:
- `me-buffer.ts`: connect, disconnect, list channels.
- `me-curator-templates.ts`: CRUD on templates and the address book.
- `curator-compose.ts`: `preview` (renders every variant's caption and tags, with no Buffer call), `cards` (the upload above) and `send`.

**Send rebuilds everything server-side** from artist ids, the template and the address book. Handles, links, payouts and cards never come from the browser. The template text is the curator's own, so it's sent as written, length-checked against Buffer's `configuration` rules for each service.

**Outbound:** add `api.buffer.com` to `ALLOWED_OUTBOUND_HOSTNAMES`. Every Buffer call goes to that fixed host, so no `safeFetch` is needed. Card images still go through `isCardImageHost` as they do now.

**R2 by binding.** Add the `unstream-social-cards` bucket to `wrangler.jsonc` as an `r2_buckets` binding, plus a `staging` one (a separate bucket, or none, so staging can't write production's cards). Then re-run `npx wrangler types --path workers/worker-configuration.d.ts`. The weekly generator keeps its own scoped S3 token; it runs in GitHub Actions, not the Worker.

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

**No migrations.** `npm run dev:worker` runs against production Supabase, and a migration applied from an unmerged branch blocks every later migration on `main` (see "Database / migrations" in `CLAUDE.md`). So the hackathon build stores nothing new:

1. **Buffer access from Worker secrets, admin only.** `BUFFER_CURATOR_ACCESS_TOKEN` and `BUFFER_CURATOR_ORG_ID` (`wrangler secret put` in production, `.dev.vars` locally), gated to `ADMIN_EMAIL` the way tips are (`canSetUpTips`). No connect screen yet: channels come from Buffer's `channels` query.
2. **One built-in template** ("Tonight's show"), editable in the page for that post only. Saving templates comes later.
3. **Mentions** via `/api/suggest`, which only finds stored artists; no paste-a-list.
4. **Instagram and Facebook previews,** cards drawn, tags on the cover card.
5. **Share now, or save as a Buffer draft.**
6. **Missing handles** can be typed in for this post only.

Demo: pick "Tonight's show", mention five artists, add one missing Instagram handle, watch both previews fill, Share Now, then open the posts in Buffer.

## Build plan

For a local Claude Code session. Read `CLAUDE.md` first, especially "The Cloudflare Worker". Develop against `npm run dev:worker` (port 8787). Like the old `npm run dev`, it reads and writes **production** Supabase, so a Share Now from it is a real post and a save is a real row.

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

**3. Cards in the browser.**
- Split `scripts/social-card-render.ts` into a platform-neutral core (the SVG builders and `renderSocialCard`) and asset loaders:
  - **Node:** today's `readFileSync` + `createRequire`, for the generator.
  - **Browser:** `fetch` the three fonts in `scripts/social-card-fonts/` and resvg's wasm, copied into the web build as static assets.
  
  The core must not import `fs` or `module`, or Vite can't bundle it. Make the loader async (`fetch` is), replacing today's synchronous `loadCardAssetsWith`.
- The generator's tests must still pass unchanged, which proves the split didn't change its cards.
- Add two slides: `cover` (kicker from the curator's show name, one row per artist, footer `via @handle · unstream.stream`) and `curator-artist` (kicker, name, location, payout panel, release; no photo).
- `api/functions/social-card.ts` and its Netlify proxy are being deleted separately (Phase 0.3's follow-up). Nothing here depends on them.

**4. Endpoint: `api/functions/curator-compose.ts`.**
- `POST /api/curator/preview`, `POST /api/curator/cards` and `POST /api/curator/send`, each a route in `workers/routes.ts` and registered in `workers/function-handlers.ts`.
- **Card storage:** add the `unstream-social-cards` R2 binding to `wrangler.jsonc` (production only; staging gets its own bucket or none) and regenerate `workers/worker-configuration.d.ts`.
- Admin-gated through `authenticateAdmin` for the hackathon. Export through `withSentry`, list the file in `api/tsconfig.json`'s include, and add tests in `__tests__/`.
- The body carries artist ids, an optional release per artist, the post's template text, typed-in handles and the send mode.
- **Everything else is looked up on the server:** artist rows and links through `db.ts`, payouts from `platform-registry.ts`, and handles from the artist's links plus the typed-in ones. Check typed-in handles against Instagram's username format.
- `preview` returns each network's caption, its tags and what's missing, without drawing any cards.
- `cards` checks and stores one PNG and returns its public URL (see "What goes to Buffer").
- `send` takes the card URLs `cards` returned, accepting only URLs on the cards bucket's public host under this user's prefix. Then it:
  1. Checks each card URL still answers.
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
- Caption previews run on a short debounce. The cards are drawn in the page with the real renderer (step 3) and shown as the PNGs that will be sent. They're uploaded only when the curator hits send.

**6. Check.**
- `npm run verify` passes, including the Worker's typecheck and tests.
- `npx wrangler deploy --dry-run` still bundles.
- Using `npm run dev:worker`, send to the Cult of Lightbulbs Instagram and Facebook. They're real channels, so use the draft mode until the tagging behaviour has been seen once.

**After the hackathon:** move the Buffer token, templates and address book into tables (the "Backend" section above), in a migration merged to `main` before any branch depends on it. Then OAuth, paste a list, and results.

## Later

Saved templates and the address book; paste a list; a list page per post; OAuth; a "your last posts" panel pulling `aggregatedPostMetrics` for the `unstream: curator` tag, next to Unstream's own count of clicks through to buy pages.

## Open questions

1. **OAuth for third-party apps.** Buffer's docs describe authorization code flow with PKCE and client registration under Settings → API. Two outside reviews in 2026 (Zernio, PostProxy) say third-party clients can't be registered yet. Check internally.
2. **Facebook Page mentions through `annotations`.** Test with a draft post on the Kid Lightbulbs page.
3. **Instagram `userTags` through Buffer:** the most tags one cover card takes, and what happens when a handle doesn't exist. Rejected post, dropped tag, or silent failure? Test with a draft carousel on `kidlightbulbs`.
4. **Production handle coverage.** Run the query above.
5. **Demand.** Ask two or three curators (a college radio show, a small label, a zine) how they post today and whether they'd use this. Brandon's view is that Instagram and Facebook are their main networks.
