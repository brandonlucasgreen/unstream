# scripts/ — generators, and the data they write

Read this with the root `CLAUDE.md`. These scripts run unattended, in the Netlify build and in GitHub Actions, so a silent failure here is found late.

- **`data/`** — `artist-list.json` (the Wikidata list), `artists/` (~790 pre-generated SEO JSON) + `artists-manifest.json` (feeds sitemap and social posts), `dispatch/` (archive), `social-posts/`, `shipped-features.json` (served to `/changelog`); **`scripts/`** generates all of it plus the feeds and sitemap.

## Build order

**Every generator must run before `vite build`, and that ordering is load-bearing.** `vite build` fills the published `apps/web/dist` by copying `apps/web/public/`, so anything written there afterwards is never published. Put new generators **before** `cd apps/web`, and verify against the deployed artifact — the log prints success either way. (This shipped a frozen sitemap for four weeks.)

The order `npm run build` runs things in is in the root `CLAUDE.md`, under "Commands".

## Which pushes deploy

`netlify-ignore-build.sh` cancels the production build for a push that touches only paths Netlify never publishes; the root `CLAUDE.md`, "Deployment", lists them. `netlify-ignore-preview.sh` does the same job for Deploy Previews.

**Its exit code is inverted: 0 cancels, 1 builds**, and every branch defaults to deploying, because a skipped deploy leaves production silently stale. `data/` and `scripts/` are deliberately absent, since `data/` is copied into `dist/` and `scripts/` generates the manifests, feeds and sitemap — so if you add a path whose contents reach the built site, check it isn't shadowed.

A `CLAUDE.md` counts as never published wherever it sits, except under `apps/web/public/` and `data/`, which the build copies to the live site whole.

## Social posts

`schedule-social-posts.yml` runs `scripts/generate-social-posts.ts` every Monday, scheduling the following week to Buffer. The copy lives in `scripts/social-post-templates.ts` (pure, tested in `apps/web/tests/unit/`); the generator picks artists, reads each verified artist's links and release catalogue from the public `/api/artist-page` (the Action has no Supabase secrets — verified artists and retired-slug aliases come from the public `/api/artist-directory` and its `scope=aliases`; `/api/artist-releases` is owner-only), and talks to Buffer. Each day's Threads and Bluesky posts go out as one Buffer **content item** (`createContentItem`, an early-preview API); single posts use `createPost`. On indie days the Instagram post is created on its own and then added to that item (`addPostToContentItem`): a content item is all-or-nothing, and its failure payload doesn't say whether the other variants were created, so a rejected Instagram variant inside it would cost the Threads post too and couldn't safely be retried. Every post and content item carries one `unstream: …` Buffer tag for its kind (`TAGS` in the generator, created on first use), so Buffer's analytics can compare them. The rules, measured in `docs/engineering-history.md`:

- **Spotlights are written for the artist to repost**, because reposts by indie artists are the only distribution that has worked. Prominent artists get one post a week, untagged.
- **Tag on Threads only with a handle from the artist's own Threads link.** An Instagram handle that Threads can't resolve is published with its @ stripped.
- **Payouts come from `platform-registry.ts`**, never a local table; the purchase math uses the low end of a range.
- **A prominent artist's Bandcamp link counts only if the subdomain is their name** (`bandcampMatchesArtist`). The generated artist files matched those links by name, and 159 of 791 are someone else's page ("venomnoise" for Venom).
- **Instagram gets indie spotlights only, as cards Unstream draws** — never a press photo on its own, which Instagram stopped recommending (`docs/specs/instagram-original-posts-spec.md`). The generator draws each slide when it schedules the week, from the facts the caption was written from and for claimed artists only (`scripts/social-cards.ts`), uploads it to the public R2 bucket `unstream-social-cards` under a key hashed from the PNG, and hands Buffer that URL only after fetching it back as a PNG; a card that doesn't draw, upload or answer is dropped. A scheduling run with an Instagram channel stops before generating anything if an R2 setting is missing. It fetches images only from the platforms' image CDNs (`isCardImageHost`). `npm run render:social-cards -- <slug>` draws one artist's cards into `data/social-posts/preview/` without Buffer or R2. At most three hashtags, never `#newmusic` or `#newrelease`; the artist is tagged on the first card only from their own Instagram link. Instagram posts before `INSTAGRAM_DRAFTS_BEFORE` go to Buffer as drafts. `/api/social-card` (`api/functions/social-card.ts`), which drew cards on request, stays only for posts scheduled before the switch; its header says when it goes.
- **An artist's stored photo is checked before a post carries it** (`livePhotoUrl`, `scripts/social-post-photos.ts`), because Buffer fetches it on publish day and a missing one fails the post. Only a 404 or 410 drops it. A timeout, a 5xx or a generic content type (Mirlo serves WebP as `application/octet-stream`) keeps it. 12 of 139 verified artists' photos had gone stale by October 2026. The catalogue pass now repairs those (see "Keeping catalogues fresh"), but a photo can still be deleted between passes.
- **The renderer runs in the generator, not the site** (`scripts/social-card-render.ts`, fonts and their OFL licences in `scripts/social-card-fonts/`). A photo slide takes ~130ms of CPU, past an edge function's 50ms; drawing at scheduling also freezes each card with its caption, and leaves the site no endpoint that fetches remote images. It finds its fonts through `import.meta.url`. The old endpoint is bundled as CommonJS, where `import.meta` is empty, so it hands the renderer the same files through `loadCardAssetsWith` until it's removed.
- The LinkedIn page gets two posts a week; Brandon's personal LinkedIn is never posted to.

"Keeping catalogues fresh" is in `api/functions/CLAUDE.md`.

## The Dispatch

A weekly music-industry briefing. **The workflow changed on 2026-04-17:** it is delivered to the `#unstream-dispatch` Discord channel by a scheduled agent, and RSS publishing was retired — nothing new is written to `data/dispatch/`. What remains is the archive plus `scripts/generate-dispatch-feed.ts`, which still runs at build time so `/dispatch.xml` renders the historical feed.

The old "commit dispatch work directly to `main`" instruction is dead — do not follow it.

## No weekly digest in this repo

Brandon's weekly Unstream analysis runs on his Mac Studio (a Hermes cron) and is served from there, not from unstream.stream. Both repo-hosted versions were removed on 2026-10-25: the Ollama-compiled industry digest (`industry-digest.yml`, `scripts/industry-digest/`, `digest-feed.ts`, #672) and its short-lived replacement relay (`dispatch-feed.ts` at `/digest/dispatch.xml`, #671), along with the `industry-digest` branch they read. **Don't bring a digest back into this repo:** the repo is public, so anything on any branch is readable by anyone, and the analysis draws on Brandon's private notes. The code is in git history.

## Rules written up in other files

- `scripts/tsconfig.json` and `npm run typecheck:scripts`: `api/CLAUDE.md`, "Typecheck coverage".
- `generate-artist-data.ts` does its own search Phase 2 merge and needs the Bandcamp-account check: `api/functions/CLAUDE.md`, "Search flow".
- `ingest-releases.ts` (`npm run ingest:try`), `dedupe-releases.ts`, `catalog-artist.ts` and `merge-override.ts`: `api/functions/CLAUDE.md`, "Releases and the catalogue" and "Admin tools".
- `preview-release-page.ts` (`npm run preview:release`): `api/edge/CLAUDE.md`, "Seeing the release page locally".
- Any Supabase read that can pass 1,000 rows has to page: `api/functions/CLAUDE.md`, "Reading the database".
