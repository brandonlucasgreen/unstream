# apps/web/ — the web app

Read this with the root `CLAUDE.md` (rules for every change, local dev, testing). This file holds what only matters inside the web app: the dev-only shim, feature flags in the browser, sign-in, and the feature surfaces page by page.

## What is here

- **`apps/web/`** — the SPA: `src/services/sources.ts` is platform config + search client, `src/contexts/AuthContext` holds auth and saved artists, `public/` carries the generated `sitemap.xml` / `dispatch.xml`, `tests/` is `unit/` + `integration/` + `fixtures/`.
- **`apps/web/server/`** — dev-only API served by Vite, **not production**. See "Local dev".

Nothing in `public/` is private: `vite build` copies it to the live site as-is, so never put notes or docs there.

Rules that reach into this folder from elsewhere:

- `src/services/sources.ts` mirrors the platform registry by hand: `api/CLAUDE.md`, "Platform registry". `public/widget.js` carries a copy of the platform table too.
- `mergeWithMusicBrainzData`, `parseMultiArtistQuery` and `mergeSearchResponses` in `sources.ts` are the browser half of search: `api/functions/CLAUDE.md`, "Search flow". Read it before touching a merge by artist name.
- `Header.tsx` and `Footer.tsx` are mirrored for the release page by `api/shared/site-chrome.ts`, and `PlatformIcon` reads its marks from `api/shared/platform-logos.ts`: `api/edge/CLAUDE.md`.
- A URL rendered by an edge function is not also rendered here: root `CLAUDE.md`, "One route, one renderer".

## `dev:fast` and the shim

The root `CLAUDE.md`, "Local dev", says when to use each and lists the traps of `npm run dev`. Side by side:

| | `npm run dev` (`netlify dev`, :8888) | `npm run dev:fast` (Vite, :5173) |
|---|---|---|
| Netlify functions (`api/functions/`) | **real** | not run — `apps/web/server/` shim |
| Edge functions (`api/edge/`) | **real** | not run at all |
| `netlify.toml` redirects, headers, routing | **applied** | ignored |
| Supabase data | **production** | none |
| Auth (sign-in, sessions, admin) | **works** | dead — "Auth not configured" |
| `/data/**` (changelog) | served | 404s as the SPA shell |
| Boot | ~15s | ~1s |

Two more traps belong to `dev:fast`:

- **The stale port.** `dev:fast` passes `--strictPort` on purpose; the `[dev]` block in `netlify.toml` says why removing it lets another checkout's leftover server answer everything.
- **The shim is not the backend.** Only `dev:fast` uses `apps/web/server/`, whose search implementation has drifted. Editing `search-sources.ts` does not change what `dev:fast` returns; editing `apps/web/server/*` does not change production. Concretely, the shim's `/api/suggest` returns a hardcoded empty list where `npm run dev` returns real `artists` rows.

## Tests

Where the suites live and what CI runs is in the root `CLAUDE.md`, "Testing". For the tests here: Default environment is `node` — add `// @vitest-environment jsdom` atop a `.tsx` test needing a DOM. Both alias `src` → `apps/web/src`.

## Feature flags: the server decides, everywhere

Flags (`FEATURE_FLAGS` in `api/functions/feature-flags.ts`, switched at `/admin/flags`) are read only on the server, from Redis, and fail closed. Each one has a gate function the endpoints share (`canUseReleaseAutopost`, `canUseCuratorPosts`, `canSetUpTips` + `tipsArtists`) that lets the admin in always and everyone else once the flag is on.

**No browser surface of a flagged feature may decide visibility with `isAdmin`.** Every entry point (a button, a nav item, a link, a page) asks the server, which answers with that same gate function, typically a cheap `?summary=1` returning `{ available }` (`/api/tips/settings?summary=1`, `/api/artist-promote?summary=1`). `isAdmin` in the browser is only for tools with no flag that will never open to anyone else (`/admin/*`, merge selection, the catalogue button). The admin still sees the feature with the flag off, because the gate function lets them in, so you lose nothing by asking.

Why: on 2026-11-05 `releaseAutopost` was switched on for everyone and no artist could see it. Every endpoint honoured the flag, but the Promote button on `/my-artists` was `{isAdmin && …}`, and its comment said "switching the flag on has to show this to everyone too". A comment doesn't flip with the flag. The admin is the only person who tests a flagged feature before launch, and an `isAdmin` gate looks exactly like a working flag to them, so this can't be caught by trying it.

When adding a flag, or a new entry point to a flagged feature:

- Grep the client for every way in (`git grep -n "<route>\|isAdmin" apps/web/src`) and gate each through the server, with a test that a **non-admin** account sees it once the server says yes.
- Copy that states a flag's position by hand (Promote's label on `/for-artists`, "Coming soon" until the flag opened) doesn't follow the flag; change it in the same PR as the decision to switch the flag on.
- The `/curator/new` item in `Header.tsx` is still `isAdmin`-gated behind `curatorPosts`; move it to a server answer before switching that flag on.

## Sign-in, two-step verification and passkeys

Supabase Auth with magic links, password sign-in, passkey sign-in, and **two-step verification** (authenticator-app codes, TOTP, as the second factor; spec in `docs/specs/two-factor-auth-spec.md`). Auth state is managed via `AuthContext` (`apps/web/src/contexts/`), which also holds saved artists. RLS policies protect all database tables — add/adjust policies in a migration when introducing new tables or columns.

**Two-step verification runs client↔Supabase; the server only refuses half-finished sessions.** Enrollment lives in the "Two-step verification" section of `/settings` (`TwoFactorSection.tsx`, `services/mfa.ts`), and `AuthContext` renders `MfaChallengeGate` in place of the whole app whenever the session is aal1 and the account has a verified factor (`needsSecondFactor` in `utils/mfa.ts`) — don't route around it. The server's half (which endpoints refuse a half-finished session, and the check a new endpoint needs) is in `api/functions/CLAUDE.md`, "Auth on the server".

**Passkeys are a way to sign in, not a second step.** Supabase offers no WebAuthn second factor for this project (passkeys as a second step were built and removed on 2026-11-01, #738), but it does offer passkey *sign-in*: the "Passkeys" section of `/settings` (`PasskeysSection.tsx`) adds and removes them, and `/login` has a "Sign in with a passkey" button plus browser autofill on the email field (`services/passkeys.ts`; spec `docs/specs/passkey-sign-in-spec.md`). A passkey sign-in is aal1, like a password, so an account with an authenticator app still meets `MfaChallengeGate`; that is what stops a passkey added from a stolen-password session from getting past the second step, so don't treat a passkey session as aal2. The API is experimental, which is why `@supabase/supabase-js` is pinned to an exact version: upgrade it on purpose and re-test passkeys on unstream.stream. Passkeys only work on the production origin (RP ID `unstream.stream`), never localhost or a deploy preview. A lost passkey is no lockout (password and sign-in links still work); to revoke one for someone, `auth.admin.passkey.deletePasskey` with the service key. Lockout recovery is manual: delete the factor via `auth.admin.mfa.deleteFactor`.

## Artist management pages

**Each thing an artist manages is its own page, with its own button on the `/my-artists` card and an item in the artist menu** (Brandon, 2026-10-29; they were tabs under Edit until then): `/analytics/:slug` (2026-11-08, the stats that used to sit on the card), `/artist-edit/:slug` (Edit, the profile), `/releases/:slug`, `/tips/:slug` (only once tips are available) and `/promote/:slug` (behind the `releaseAutopost` flag, the admin always; its button asks `/api/artist-promote?summary=1`, since only the server reads flags; tabs for Autopost, release Campaigns at `/campaigns` and the Asset library at `/assets`, all sent to Buffer by the one `release-autopost-sweep`, plus the Embed widget at `/embed` (`PromoteEmbedPage`, the same `EmbedWidgetPanel` as the artist page's Embed button, fed from the public `/api/artist-page`; nothing to do with Buffer); spec: `release-autopost-spec.md`). All share the frame in `ArtistSettingsLayout` (which page, the artist's name). Stripe onboarding returns to `/tips/:slug`. **The old tab addresses `/artist-edit/:slug/tips|releases|promote` redirect with their query kept** (`RedirectToSection`): Stripe links and tip emails already sent point at the old tips address, so don't remove them.

## Feature surfaces

One entry per feature: the pages, what backs them, and the decisions already made about them. Entries that are mostly about the server are in `api/functions/CLAUDE.md`: account endpoints (`me-*`), the claim link-back rule, admin tools (`/admin/*`), artist analytics (`/analytics/:slug`), the Bandcamp collection import, listening signals, tips, the v1 API.

### Artist profiles

Artists claim via `/claim/:slug`: sign in by magic link (or arrive signed in), then prove ownership by linking a verify URL from the artist's own website, with manual review as the fallback. When a link-back verifies instantly and when it goes to review is a server rule: `api/functions/CLAUDE.md`, "Claiming an artist". The wizard is split across `Claim*Step.tsx` (steps in `ClaimPageTypes.ts`). Claimed profiles are edited at `/artist-edit/:slug`, with release curation at `/releases/:slug` (`artist-releases.ts`). Artist pages (`/a/:slug`, `/artist/:slug`) are SPA pages for people; the `artist-page-static` edge function serves crawlers only (see "Edge functions"). "Edge functions" is `api/edge/CLAUDE.md`.

### The signed-in account

One `Account` menu in the header covers `/my-collection`, `/my-saved-artists` and `/settings` (`/my-artists` left it on 2026-11-08, once the artist menu below covered it; the page stays, as the landing for an account with several artists, and the artist pages carry no "← My Artists" link); new account pages go in that group rather than becoming another top-level nav item. **A verified artist also gets a menu of their own** (Brandon, 2026-11-08), so their pages aren't all behind My Artists: named after the artist, listing View page, Edit page, Analytics, Releases, Tips and Promote; an account with several artists gets one "Your artists" menu with a section per artist (`buildArtistMenu`, `apps/web/src/services/artistNav.ts`; no account had more than two in November 2026, so revisit the shape before labels with dozens arrive). It is filled from `GET /api/me/artist-nav` (`me-artist-nav.ts`), which answers the artists and whether Tips and Promote are open through the same gates their endpoints use (`tipsOpenToArtist`, `canUseReleaseAutopost`), and the browser asks **once per session** — every page renders its own `<Header>`, so asking on mount would cost a request and a rate-limit command per navigation for every signed-in fan. `ClaimDoneStep` drops the remembered answer. The release page's static header (`site-chrome.ts`) has no artist menu. `/my-artists` is artist management (claimed profiles, a button per page); The fan's half was split on 2026-11-08 (Brandon): `/my-collection` holds what the fan *has* — one **Releases** section (Upcoming and Recent) and the Bandcamp collection; `/my-saved-artists` holds who they *follow* — the **Release calendar** subscription at the top (`ReleaseCalendarSection`), then the saved-artists list. The calendar covers saved artists, not the collection, so `/my-collection` deliberately doesn't mention it. **Tip History** (`YourTips`, `#tips`, hidden until there's a tip) moved to its own section of `/settings` at the same time, as too slight for a page of its own yet (a fuller "My Patronage" page may come later). **`YourTips` doesn't call `/api/me/tips` until it scrolls into view** (or the `#tips` deep link asks for it outright) — one rate-limit command plus a three-table join, per view, to answer "none" for nearly every account; `/my-collection`, the landing for most sign-ins, is held to the same test. The one-time newsletter prompt sits on `/settings`, above Notifications. `/my-collection` still carries the one-time `WelcomeBanner`. **Where a sign-in lands is resolved, not fixed:** `resolveAccountHome` (`apps/web/src/services/accountHome.ts`) sends someone with one verified claim to that artist's `/analytics/:slug`, several to `/my-artists`, and everyone else to `/my-collection`, and every failure falls back to `/my-collection` so a broken profiles read can't block a sign-in. It backs the login redirect, the password-reset redirect and the PWA standalone launch; an explicit `?next=` still wins outright. Verified needs no extra check — `artist-auth`'s GET already filters to `verified_at IS NOT NULL`. The old `/dashboard` and `/artist-dashboard` routes redirect to `/my-collection` (flat, no lookup), `/artist-login` to `/login`. `/my-collection` also carries the one-time `SecurityNudgeBanner` (two-step encouragement, dismissed via `user_metadata`, same pattern as `WelcomeBanner`, linking to `/settings#two-step`).

### Saved & supported artists

Signed-in fans save artists and mark them supported (migrations 013–018), synced to the Apple app via `saved-artists-sync.ts` with tombstones and scheduled GC. A claimed public username (migration 021) plus a sharing opt-in (022) gives a public list at `/u/:handle` (`PublicSavedArtistsPage` for people, the `u-handle` edge function for crawlers), backed by `public-saved-artists.ts`; reserved handles live in `api/lib/reserved-handles.ts`.

### Release alerts and feeds

`check-releases.ts` reads the catalogue and `notifications.ts` emails fans about new releases and new platform links (plus claim approved/rejected mail), with `email_log` as the "already sent" guard; preferences are `me-notifications.ts` (`/api/me/notification-preferences`). `feed-releases.ts` serves calendar and RSS feeds: private ones at `/feed/f/{token}.ics|.xml` (token from `me-feed-token.ts`, minted only on an explicit press — never on mount) and public ones at `/u/:handle/releases.*` and `/a/:artist/releases.*`. The private feed's only entry point is the **Release calendar** at the top of `/my-saved-artists` (it sat under Releases on `/my-collection` until 2026-11-08, and on `/settings` for months before that, where not one fan ever minted a token). It is gated on the fan having saved somebody, as is Releases — **deliberate** (Brandon, 2026-10-21), since the feed of nobody carries nothing; don't ungate it or add a second *subscribe* entry point to make the calendar reachable sooner. **Revoking is the exception, and has to be**: a token outlives the saved artists that justified it, so `ReleaseFeedOffSwitch` takes the calendar's place on `/my-saved-artists` when the fan has saved nobody (the calendar's own controls turn a link off otherwise). `/settings` has no release-feed section since 2026-11-08. The switch is DELETE only, asks nothing on mount — a GET would mint a token for everyone who opened the page — and must not grow a create or rotate button. `weekly-analytics-recap.ts` (artist recap email) is **paused** — no schedule, toggle hidden; its workflow header says how to restore it.

### Platforms and FAQ, not guides

The guides section was retired on 2026-09-27: SEO pieces that drew no traffic and weren't in Brandon's voice. What was documentation became `/platforms` (generated from `sources.ts`, so it can't drift from the registry) and FAQ entries in `apps/web/src/data/faq.ts` (mirrored by hand in `apps/web/public/faq.txt`). Old `/guides/*` URLs are 301s in `netlify.toml`; `/guides.xml` is a frozen copy in `apps/web/public/`. Don't bring back long-form content here; Brandon's writing lives in his newsletter.

### AI crawlers: cited yes, trained no

`apps/web/public/robots.txt` lets search engines and AI answer/search bots in and refuses AI training crawlers, matching the Terms of Use; the list and the reason live in the file, pinned by `robots-txt.test.ts`. Never name an allowed bot in a group of its own: a named bot stops reading `*`.

### Newsletter

Unstream has no newsletter of its own. Updates go out in Brandon's newsletter, Lightbulbs On (Buttondown), and every signup names it (`apps/web/src/data/newsletter.ts`). Signups go through `newsletter-subscribe.ts` (double opt-in), from the inline forms, an unticked checkbox on the claim flow, and a one-time prompt on `/settings`, above Notifications (it was on the signed-in home until the Account split; the `unstream` source tag stayed put so the Buttondown cohort reads continuously). **Not on `/login`**: it is sign-up and sign-in at once, and telling them apart before auth would leak which emails have accounts. The source becomes a Buttondown tag: the inline forms tag their page (`changelog`, `contact`, `platforms`), the claim checkbox `artist`, the one-time account prompt `unstream`.

### Unknown paths

`main.tsx`'s last route is `path="*"` → `NotFoundPage`, imported **eagerly** while every other page is lazy: the catch-all exists for navigations that have already gone wrong, and a superseded build's chunks are deleted. It sets `noindex`, because the SPA shell answers 200 for every unmatched path. Before it, an unknown path rendered an empty `#root` — a white page that reads as a crash, and the shape a stale service worker takes when it meets a route newer than its build.

### Smaller pieces

`/api/suggest` typeahead (`search-suggest.ts`, reads `artists`); the embeddable widget (`apps/web/public/widget.js`, plain JS served as-is: its platform table is a copy pinned by `platform-logo-copies.test.ts`, and the embed customiser (`EmbedWidgetPanel`, behind the artist page's Embed button and the Promote page's Embed widget tab) previews by running this same file through `window.UnstreamWidget.init()`, from the very `data-*` attributes the snippet carries, rather than a mock-up, so don't rebuild the preview in React; custom colours are `data-bg`/`data-text`, accepted only as hex because they go into its stylesheet; `data-layout` is `icons`, `text`, `flexible` or `full`; `data-platforms` is a list of platform ids in display order (an artist's custom links count as ids too, `other_0`, `other_1`, ..., positional in page order, so deleting one shifts the rest in a subset embed), which the artist drags into place in the panel (`EmbedPlatformList`, on the shared `SortableList` (`@dnd-kit`), which the edit page's links and page sections use too; lazy-loaded with the panel so fans never download it) independently of their page's order; a `*` in the list adds every other link after it in page order, so links added later still appear, and `all` alone is page order; embeds copied before it keep `data-max-links` and the widget's priority order; the snippet carries a plain link to the artist's page inside the `<div>`, which the widget's shadow root hides once it renders, so a visitor whose content blocker refuses `widget.js` still gets somewhere, and the preview says when this browser didn't run it. No public filter list (EasyList, EasyPrivacy, Fanboy, AdGuard Base/Tracking/Social/Annoyances/Mobile) blocked `widget.js`, its API calls or the container as of 2026-11-09; Safari blockers match URLs and CSS selectors, never script contents); `/api/embed/bandcamp` (`embed-bandcamp.ts`); `purge-cache.ts` (CDN tag purge after a claimed artist edits). `/for-artists` (`ForArtistsPage`) is the page to send an artist to: what claiming gets them, with a search that lists claimable rows and links into `/claim/:slug` (`ClaimSearch`); its feature claims must stay true; Promote, open to every artist since 2026-11-05, carries a "Beta" label. Other SPA pages: `/artists` directory, `/known-artists`, `/support` (`/plus` 301s there), `/changelog`, `/roadmap`, `/press`, `/contact`, `/extension`, `/developers`.
