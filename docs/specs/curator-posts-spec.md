# Curator posts: tag the artists you champion

**Status: paused indefinitely (Brandon, 2026-10-28; confirmed 2026-10-29). Don't build any more of it.** The admin-only build is merged (#697–#708) and stays live behind the `curatorPosts` flag, so the work isn't thrown away; nothing below is planned. There was no clear reason a promoter would switch to it, and venues have brand and artwork rules that Unstream-drawn cards can't follow without uploads. Its Buffer connection is reused by `release-autopost-spec.md`. Proposed 2026-10-21, as Brandon's Buffer Commit hackathon entry; rewritten for Netlify on 2026-10-27, after the Cloudflare Worker port was removed. "Build plan" lists the order to build it in, starting with checking the open questions. The UI mockup is the "Unstream curator posts" design canvas (see "UI").

**Written for Netlify.** The first draft assumed the Cloudflare Worker port (#653, #663). That port was **removed on 2026-10-23**, because Bandcamp challenges every page request from a Worker and takes discovery, card data and the catalogue with it (`docs/specs/bandcamp-from-workers.md`). Unstream stays on Netlify's legacy plan. So:

- routes are `[[redirects]]` entries in `netlify.toml`, one per path — there's no catch-all for functions
- secrets are Netlify environment variables, and `.env` locally
- local full-stack development is `npm run dev` (port 8888)
- a new function in `api/functions/` is typechecked just by being there: `api/tsconfig.json` includes `functions/*.ts`. Its **test** file still needs listing by name.

The one place this costs something is R2 (no binding — see "Backend"). The one place it saves a lot is the cards, which a Lambda can draw itself (see "What goes to Buffer").

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

1. **Connect Buffer** (once). If the Buffer account belongs to more than one organization, the curator picks which one Unstream posts through. **It is never guessed** (2026-10-28): taking the account's first organization posted from someone else's workspace, since an account belongs to every organization it was invited to. With exactly one it's kept without asking. Then Unstream lists that organization's Instagram and Facebook channels and the curator ticks the ones it may post to. Sending posts to the ticked channels only, read from storage rather than from the page, and the first ticked Instagram account signs the cards, so the curator never types their own handle.
3. **Pick a template.** One of the defaults, or one the curator saved (see "Templates").
4. **Add artists as mentions.** Typing `@` searches Unstream's stored artists (the `/api/suggest` typeahead) and falls back to a full search when nothing stored matches. Picking a result inserts a chip tied to that artist's id, optionally with a release. The curator confirms every match, so nothing is guessed. **Paste a list** turns each pasted line into a mention waiting for confirmation, for the 20-artist radio show.
5. **Preview each channel.** One tab per channel, rendered from the template exactly as it will post: caption, cards, tags, character count. Each chip shows its handle on that network, or a "no handle" warning with an "add one" field (see "Handles").
6. **Send.** Share now, add to queue, a set time, or save as a draft in Buffer. The confirmation links to the posts in Buffer.

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
- Cards are drawn by the existing renderer (`scripts/social-card-render.ts`, in the function; see below): dark ground, accent kicker, display name, payout panel. The kicker is the curator's (`TONIGHT ON NIGHT SHIFT`) and the footer reads `via @curator · unstream.stream`. Cards Unstream draws count as original content to Instagram; press photos alone don't.
- Tagging: `assets[].image.metadata.userTags`. On a carousel, **the first image's tags apply to every slide** (checked 2026-10-01), so all known artist handles go on the cover card, each at its own position. Caption `@handles` notify too.
- No clickable links on Instagram, so `{link}` becomes "link in bio" or "search them on unstream.stream".

**Facebook**
- The same cards with the caption, and a clickable `{link}`.
- **Facebook gets names and links, no tags — the fallback, taken deliberately (2026-10-27).** An `@handle` typed in a Facebook caption tags nobody, and the `annotations` mechanism works (open question 2) but needs `content` to be the Page's **numeric Facebook id**. We hold artists' Facebook links as `facebook.com/<name>`, and there is no way to turn one into a Page id without a Graph API call Unstream can't make. The probe only worked because the Page was our own channel, whose id Buffer hands us as `serviceId`.
- So `{artist}` renders as the artist's **name** on Facebook, never `@handle`. That is also the text an annotation's `indices` would have to point at, so nothing is wasted if Page ids ever become reachable.
- **A consequence for the UI:** the Facebook circle on each artist row can't mean "will be tagged". It means "we hold their Facebook page", and the mockup's teal/dashed states should say so for that network.

**Cards are drawn in the function, with the generator's own renderer.** An earlier draft drew them in the browser, because a Worker can't read fonts off disk. A Netlify Lambda can, and one already does: `api/functions/social-card.ts` renders these same cards on request, from the same `scripts/social-card-render.ts`. The curator endpoint does the same thing, which means no renderer split, no wasm in the web bundle and no second asset loader.

- **The two lines of config that make it work.** `social-card` declares them in `netlify.toml`, and the curator function needs its own copy:

  ```toml
  [functions."curator-compose"]
    included_files = ["scripts/social-card-fonts/*.ttf"]
    external_node_modules = ["@resvg/resvg-wasm"]
  ```

  The bundler can't see either kind of file through an import: the fonts are read at runtime by path, and bundling resvg into JS leaves it unable to find its `.wasm`.
- **The preview is the real card, one round trip away.** The compose page asks `/api/curator/cards` for each PNG and shows what comes back, so what the curator sees is exactly what Buffer gets. A card is ~130ms of CPU, so the page debounces and draws the cover first.
- **Storage is R2 over its S3 API,** reusing `publishCard` from `scripts/social-cards.ts`. The function draws the PNG, writes it to the `unstream-social-cards` bucket under `curator/{user-hash}/{sha256}.png`, fetches the public URL back as the generator does, and returns it. The key's user hash keeps one curator's cards out of another's prefix and away from the generator's.
- **No photos on curator cards for now — a scope choice, not a limit.** Drawing server-side there's no CORS problem: the function can fetch artist photos the way `social-card.ts` does, through `isCardImageHost` and the outbound allowlist. The hackathon cards stay text-only to match the mockup. Photos are the obvious first addition, and `livePhotoUrl`'s rule (only a 404 or 410 drops a photo) applies when they land.
- **A card that won't draw blocks sending** with a visible error. It's never sent blank.

## Links

- **One artist:** `unstream.stream/a/{slug}`. It lists every place to buy with its payout, which is the point.
- **Several artists, for the hackathon:** Facebook gets one link per artist in the caption. Instagram says "every artist's links: unstream.stream/u/{curator}". The curator's `/u/` page already exists. `{curator}` is their **Unstream username**, read on the server and only while their list is public (`getPublicUsername`), else "link in bio". It is not their Instagram handle: the two were one field until 2026-10-28, which pointed captions at whoever owned that name on Unstream.
- **Later:** a page for each post at `/u/{handle}/l/{slug}`, listing the artists with their buy links. It follows the existing `u-handle` split: crawlers get the server-rendered page, browsers get the SPA.

## Backend

**Buffer auth: OAuth, one connection per user.** Settled 2026-10-27 — Buffer registers third-party clients at Settings → API, and Brandon can register Unstream's. The 2026 outside reviews that said otherwise (Zernio, PostProxy) are out of date.

- **Authorization Code with PKCE**, which Buffer *requires* of every client, `code_challenge_method=S256`. Authorize at `https://auth.buffer.com/auth`, exchange at `https://auth.buffer.com/token`.
- Unstream is a **public client** (since 2026-10-30; it began as a confidential one): its source is open, so it proves itself with PKCE alone and sends **no** `client_secret`, which Buffer refuses from a public client. `BUFFER_CLIENT_ID` is the one Netlify variable this feature needs beyond the card bucket's; `BUFFER_CLIENT_SECRET` stays unset (the code sends a secret only when one is set).
- **Scopes:** `posts:write` to create the posts, `account:read` to list the curator's channels, and `offline_access`, **without which Buffer issues no refresh token at all**.
- **An access token lasts an hour** (`expires_in: 3600`), so a curator who connected yesterday has an expired token. Every call refreshes first when the stored token is within a minute of expiry; there is no "just use the stored token" path.
- **Refresh tokens are single-use, and reusing one revokes the whole grant.** Buffer returns a new refresh token on every refresh and invalidates the old one; replaying an old one logs the curator out of Unstream's integration entirely and they must reconnect. Two consequences the code has to honour:
  - **Store the new refresh token before using the new access token**, so a crash mid-flight can't leave us holding a token Buffer has already retired.
  - **Never refresh concurrently for one user.** Two requests refreshing at once would each present the same refresh token, and the second one revokes the grant. Serialise it (a conditional update on the stored token, so only one writer wins) rather than hoping it doesn't happen.
- A `401` means the curator revoked access in Buffer's settings. Clear the connection and ask them to reconnect; don't retry.

**`buffer_connections`** holds one row per user: `user_id`, encrypted access and refresh tokens, `expires_at`, `organization_id`, selected channel ids. Tokens are encrypted with `credential-crypto.ts`, as Bandcamp credentials are. Server-only: RLS enabled with **no** policies, and a comment saying the missing policies are deliberate — the service-role client bypasses RLS and anon gets nothing.

**Tables.** New migration, `IF NOT EXISTS` guards, RLS owner-only:
- `curator_templates`: `user_id`, `name`, `post_text`, `line_text`, timestamps.
- `curator_handles`: `user_id`, `artist_id`, `network`, `handle`, unique on (`user_id`, `artist_id`, `network`).
- `curator_profile` fields (`show_name`, `label_name`) as columns on the existing per-user settings, not a new table, if they fit there.

**Functions.** Each goes through `resolveAccountRequest`, exports through `withSentry`, and has a test in `__tests__/`. Each also needs a `[[redirects]]` entry in `netlify.toml`. The function itself is typechecked by living in `api/functions/`; its **test** file needs a line in `api/tsconfig.json`'s include list.

The functions:
- `me-buffer.ts`: connect, disconnect, choose the organization, list and tick channels.
- `me-curator-templates.ts`: CRUD on templates and the address book.
- `curator-compose.ts`: `preview` (renders every variant's caption and tags, with no Buffer call), `cards` (the upload above) and `send`.

**Send rebuilds everything server-side** from artist ids, the template and the address book. Handles, links, payouts and cards never come from the browser. The template text is the curator's own, so it's sent as written, length-checked against Buffer's `configuration` rules for each service.

**Outbound:** add `api.buffer.com` to `ALLOWED_OUTBOUND_HOSTNAMES`. Every Buffer call goes to that fixed host, so no `safeFetch` is needed. Card images still go through `isCardImageHost` as they do now.

**R2 by scoped S3 token.** Netlify has no R2 binding, so the function signs its own request, reusing `publishCard` (`scripts/social-cards.ts`, `aws4fetch`) and the same scoped token the weekly generator uses. Two things that needs:

- **`aws4fetch` moves from `devDependencies` to `dependencies`,** or it isn't bundled into the function.
- **Its five variables are set in Netlify:** `SOCIAL_CARDS_BUCKET`, `SOCIAL_CARDS_PUBLIC_BASE_URL`, `R2_ACCOUNT_ID`, `SOCIAL_CARDS_R2_ACCESS_KEY_ID`, `SOCIAL_CARDS_R2_SECRET_ACCESS_KEY`. Today they exist only as GitHub Actions secrets. Set them secret-flagged, which makes them write-only — `netlify env:get` returns asterisks, so keep the values wherever they came from.

A deploy preview shares production's environment and would write to the same bucket; the user-hash prefix in the key keeps that out of the generator's objects.

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
- **Connect:** "Buffer connected" plus a checklist of the account's channels. Instagram and Facebook can be ticked; every other network is counted, not listed. An account in several organizations is asked which first, and can change it later from the compose page.
- **Sent:** one row per channel with a "View post" link, and three result tiles (reach, artist page visits, clicks to buy) left empty until there's data.
- **Cards:** the existing card style (`scripts/social-card-render.ts`). The cover card has kicker, title, and one row per artist with tag bubbles; each artist card has kicker, name, location, payout panel and the release.

## Hackathon cut

**Built for curators, not demoed on one account** (decided 2026-10-27, superseding the admin-token cut this section first described). The scope that ships:

1. **Each curator connects their own Buffer account** over OAuth, and posts from their own tokens. `BUFFER_CLIENT_ID` is the only new Netlify variable (a public client has no secret; see "Backend"); the connection lives in `buffer_connections`. **Don't leave it blank in `.env`** — a blank value shadows the real one from the site settings, and `netlify dev` only says so in an `Ignored project settings env var` line.
2. **Gated by the `curatorPosts` feature flag**, in the existing store and failing closed, so it is invisible until switched on at `/admin/flags`. The flag is what holds it back, with one exception: the admin account (`ADMIN_EMAIL`) is always let through (`canUseCuratorPosts` in `buffer-db.ts`), so it can be tested end to end before it is switched on — the tips precedent.
3. **One built-in template** ("Tonight's show"), editable in the page for that post only. Saving templates comes later.
4. **Mentions** via `/api/suggest`, which only finds stored artists; no paste-a-list.
5. **Instagram and Facebook previews,** cards drawn, tags on the cover card.
6. **Share now, or save as a Buffer draft.**
7. **Missing handles** can be typed in for this post only.

Demo: pick "Tonight's show", mention five artists, add one missing Instagram handle, watch both previews fill, Share Now, then open the posts in Buffer.

## Build plan

For a local Claude Code session. Read `CLAUDE.md` first, especially "Local dev: the full stack, and the fast shim". Develop against `npm run dev` (port 8888) — `dev:fast` runs no functions at all. It reads and writes **production** Supabase, so a Share Now from it is a real post and a save is a real row.

**If you work in a git worktree,** pass the worktree's own functions folder: `npm run dev -- --functions "$PWD/api/functions"`. Otherwise netlify-cli finds the main checkout's root and serves *its* `api/functions/`, so a new function answers `Function not found` and an edited one silently runs the old code.

**0. Check the unknowns with Buffer drafts. — DONE 2026-10-27.** Two drafts were created on the real Cult of Lightbulbs channels and deleted. Findings are in "Open questions" 2 and 3, and they carry one rule into step 4: **Buffer validates nothing, so `curator-compose` must validate handles itself.**

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

**3. Cards, drawn in the function.**
- **Reuse the renderer unchanged.** `scripts/social-card-render.ts` already draws through `@resvg/resvg-wasm` and takes its fonts from `loadCardAssetsWith`; `renderSocialCard` is already async. `api/functions/social-card.ts` is the worked example of calling it from a Lambda — read it first. No split, no browser build, no loader rewrite: those were only needed because a Worker can't read fonts off disk.
- **Add the `[functions."curator-compose"]` block** to `netlify.toml` (see "What goes to Buffer"). Without it the fonts aren't in the bundle and resvg can't find its `.wasm`, and both failures appear only at runtime in production.
- **Add two slides** alongside the existing ones: `cover` (kicker from the curator's show name, one row per artist with tag bubbles, footer `via @handle · unstream.stream`) and `curator-artist` (kicker, name, location, payout panel, release; no photo).
- The generator's existing card tests must still pass, which proves the new slides left the old ones alone.
- `api/functions/social-card.ts` stays for now — it's kept for Buffer posts scheduled before the generator started uploading its own cards, and its header says when it can go. Nothing here depends on it, and nothing here should extend it.

**4. Endpoint: `api/functions/curator-compose.ts`.**
- `POST /api/curator/preview`, `POST /api/curator/cards` and `POST /api/curator/send`, each a `[[redirects]]` entry in `netlify.toml` pointing at the function.
- **Card storage:** `publishCard` and the scoped S3 token (see "Backend"), which also means moving `aws4fetch` into `dependencies` and setting its four variables in Netlify.
- Admin-gated through `authenticateAdmin` for the hackathon. Export through `withSentry` and add tests in `__tests__/`, listing the **test** file in `api/tsconfig.json`'s include — the function itself is already covered by `functions/*.ts`.
- The body carries artist ids, an optional release per artist, the post's template text, typed-in handles and the send mode.
- **Everything else is looked up on the server:** artist rows and links through `db.ts`, payouts from `platform-registry.ts`, and handles from the artist's links plus the typed-in ones. Check typed-in handles against Instagram's username format.
- `preview` returns each network's caption, its tags and what's missing, without drawing any cards.
- `cards` draws one slide, stores it and returns its public URL (see "What goes to Buffer").
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
- Caption previews come from `preview`, on a short debounce, and cost nothing but a round trip.
- **Cards come from `cards`,** already drawn and stored, and the page shows those PNGs — so the preview is the artifact, not a likeness of it. Draw the cover first and the artist cards behind it; at ~130ms of CPU each, a five-artist post is six draws. Redraw only what changed: the key is the slide's own inputs, so editing the caption alone redraws nothing.

**6. Check.**
- `npm run verify` passes.
- **The function really bundles its fonts.** The `included_files` and `external_node_modules` block is in no test, and a missing font only shows up as a failed draw in production. Draw a card through `npm run dev` and check `.netlify/functions-serve/curator-compose/` holds the three `.ttf`s and resvg's `.wasm`.
- Using `npm run dev`, send to the Cult of Lightbulbs Instagram and Facebook. They're real channels, so use the draft mode until the tagging behaviour has been seen once.

**Already shipped, ahead of this plan:** OAuth, and the Buffer token in `buffer_connections`. The rescope to per-user accounts (2026-10-27) brought both forward from here.

**Still to come:** saved templates and the address book as tables of their own, paste a list, and results. Two rules for their migration, both learned the hard way — merge it to `main` before another branch depends on it, because `supabase db push` aborts outright when production holds a version the branch doesn't; and give it a leading timestamp no other migration has, because Supabase keys on exactly that and silently skips a duplicate.

## Later

Saved templates and the address book; paste a list; a list page per post; a "your last posts" panel pulling `aggregatedPostMetrics` for the `unstream: curator` tag, next to Unstream's own count of clicks through to buy pages. (OAuth was on this list and shipped instead.)

## Open questions

1. ~~**OAuth for third-party apps.**~~ **Answered 2026-10-27: yes.** Buffer registers third-party clients at Settings → API and Brandon can register Unstream's, so this is built for curators on their own Buffer accounts rather than for one admin token. The flow, scopes and the single-use refresh-token hazard are in "Backend". The outside reviews that said registration was unavailable (Zernio, PostProxy) are out of date.
2. **Facebook Page mentions through `annotations` — the mechanism is right; rendering is still unproven.** (Draft `6ae0e17e…` on the Kid Lightbulbs page, 2026-10-27, since deleted.) Buffer accepts `metadata.facebook.annotations` and stores it. Three things learned:
   - All four fields are required: `{ content, indices, text, url }`.
   - **`content` is the Page's *Facebook* id, not its Buffer channel id** — Buffer calls it `serviceId`, read with `channel(input: { id: $id }) { serviceId }` (note the id's type is `ChannelId!`, not `String!`). Kid Lightbulbs is Buffer `672d115fda2e3cb64c165cb5` → Facebook `123813724362975`.
   - On read-back Buffer **adds `"type": "mention"`**, a field we never sent. It models these as mentions explicitly, which is the strongest evidence short of publishing that this is the Page-mention mechanism.
   - `indices` are `[start, end)` character offsets into the post text, end-exclusive.
   
   **Still open:** whether Facebook actually renders the tag. That can only be seen by publishing, which wasn't done. The spec's fallback — names and links, no tags — stays until a real post proves otherwise.
3. **Instagram `userTags`: Buffer validates nothing at creation, so we must.** (Draft `6ae0e14d…` on `kidlightbulbs`, 2026-10-27, since deleted.) A carousel carrying three `userTags` on the cover — two real (`kidlightbulbs`, `unstream.stream`) and one invented (`zzq-not-a-real-handle-9f3a`) — was accepted with `error: null`, and **all three were stored verbatim**. Re-read a minute later, the draft was unchanged (`updatedAt` still equalled `createdAt`): there is no async handle check either.
   
   **So a bad handle is not caught by Buffer at any point we can observe before publish.** `curator-compose` has to check handles itself — which matters more here than elsewhere, because a typo would surface inside a content item that is all-or-nothing, taking the Facebook post down with the Instagram one.
   
   **Still open:** the ceiling on tags per image. Three were accepted; nothing here probed the limit, and no number should be assumed.
   
   Incidental, and consistent with what the generator already sees: Buffer records `mimeType: "image/jpeg"` for a PNG source while keeping our URL as `source`, and read back `width`/`height` as 1080×1350.
4. **Production handle coverage.** Run the query above.
5. **Demand.** Ask two or three curators (a college radio show, a small label, a zine) how they post today and whether they'd use this. Brandon's view is that Instagram and Facebook are their main networks.
