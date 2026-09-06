---
status: Done
---
# UNS-105 — No-JS accessibility fallback: static-HTML edge function for /a/*

**Linear:** [UNS-105](https://linear.app/cultoflightbulbs/issue/UNS-105) (UNS-100e)
**Spec body:** UNS-105 issue description (this doc is a working expansion for the implementer)
**Parent:** UNS-100 (collapse the MPA↔SPA bifurcation for `/a/{slug}`)
**Sibling:** UNS-104 (remove the old `claimed-artist-page` edge function — must ship with or after this)
**Owner:** Daryl
**Reviewer:** Dan
**Coordinator:** Wayne
**Status:** Ready for Daryl — pending Brandon's sign-off on the scope

## Why this exists

After UNS-100a/b/c landed and PR #275 cleaned up the navigation, the SPA is the *only* renderer for `/a/{slug}`. Without JavaScript, the user gets an empty `<div id="root"></div>`. That's a regression for users on slow networks, JS-disabled browsers, and crawlers that don't execute JS. Brandon's principle: Unstream is accessible to anybody, including when JavaScript is disabled.

The existing `api/edge/claimed-artist-page.ts` is the *old* server-renderer that UNS-100 made redundant. It was *only* for claimed artists and it included a theme-toggle JS script + an auth localStorage reader — both of which fail silently without JS. We're keeping it for one more release to maintain coverage while the new function ships, then removing it in UNS-104.

## What to build

A new edge function `api/edge/artist-page-static.ts` that:
- Runs on every `/a/*` request, **before** the SPA loads
- Returns fully-rendered HTML for *both* claimed and unclaimed artists (so the SPA fallback is uniform regardless of state)
- Has **zero JavaScript** in the response (no theme toggle, no auth localStorage reader, no analytics)
- Includes OG/Twitter meta tags + JSON-LD structured data
- Re-uses the existing platform/icon/payout data from `api/shared/platform-registry.ts`
- Embeds the same `ALLOWED_EMBED_DOMAINS` allowlist for the featured-embed iframe (sandboxed, no JS execution)

The new function replaces `claimed-artist-page.ts` for `/a/*` routing. After this ships, `claimed-artist-page.ts` is dead code (UNS-104 removes it).

## What to change

### 1. New edge function: `api/edge/artist-page-static.ts`

**Modeled on the existing `claimed-artist-page.ts` (452 lines).** Key differences:

| Aspect | `claimed-artist-page.ts` (old) | `artist-page-static.ts` (new) |
|---|---|---|
| Audience | Claimed artists only | Claimed + unclaimed (unified) |
| Theme toggle | Inline JS `<script>` block | No JS; CSS prefers-color-scheme media query only |
| Auth UI | Reads localStorage, shows email/sign-out | No auth UI; show generic "Login" link (always visible) |
| Analytics | No tracking (it predated) | No tracking |
| Featured embed | Raw HTML inline | Sandbox iframe: `<iframe src="..." sandbox="allow-scripts allow-same-origin">` (or whatever the existing allowlist requires — match the SPA's `<RichArtistProfile>` behavior) |
| Embed domains | Inline HTML allowlist | Re-use `ALLOWED_EMBED_DOMAINS` from `api/functions/artist-profile.ts` |
| Bandcamp Friday | Already uses `isBandcampFriday()` | Same |
| OG meta + JSON-LD | Already has both | Keep both; extend to unclaimed too |

**Data shape:** fetch from Supabase the same way `claimed-artist-page.ts` does. Add an unclaimed branch:
- Unclaimed artist: `match_confidence !== 'claimed'` OR no `profile.verified_at`
  - Render a simpler card (no bio, no featured embed, no "Verified" badge)
  - Show platform links + social links same as claimed
  - Add a "Claim this profile" CTA linking to `/claim?slug={slug}`
  - JSON-LD should still be a `MusicGroup` (per MusicBrainz-style metadata) but without `sameAs` claims that are speculative

**Routing priority (in `netlify.toml`):**
```toml
[[edge_functions]]
path = "/a/*"
function = "artist-page-static"
```

This must REPLACE the `claimed-artist-page` registration, not coexist. Otherwise `/a/{slug}` could match the new function but fall through to the old one in some edge cases.

### 2. Remove the JS from the new function's response

- Drop the theme-toggle `<script>` block
- Drop the auth localStorage reader `<script>` block
- Use a `<noscript>` block in the SPA's `index.html` (item 3 below) as a defensive fallback for the case where the edge function *also* doesn't run
- Verify with `curl -s ... | grep -c '<script' | grep -q 0` — zero `<script` tags in the response

### 3. SPA defensive `<noscript>` block in `apps/web/index.html`

**The existing index.html already has a `<noscript>` block** (visible in the file at line 21+). Read the existing one first — don't add a duplicate. If the existing one already covers "browse the artist index" + "search for an artist", no change needed. If it doesn't mention those, extend it.

**Defensive purpose:** if the edge function *somehow* doesn't run on a request (cache miss, deploy race, etc.), users with JS disabled get a fallback. The edge function is the primary defense; the `<noscript>` block is the belt-and-suspenders.

### 4. Update `netlify.toml`

Replace:
```toml
[[edge_functions]]
path = "/a/*"
function = "claimed-artist-page"
```
with:
```toml
[[edge_functions]]
path = "/a/*"
function = "artist-page-static"
```

### 5. Update `apps/web/vite.config.ts` — `navigateFallbackDenylist`

The current denylist excludes `/a/*` and `/artist/*` from the service worker fallback (so the edge function handles them). The denylist for `/a/*` should STAY (otherwise the SW would serve the empty SPA shell for non-JS users). The denylist for `/artist/*` (the old `/artist/{slug}` redirect target) can be removed since `claimed-artist-page` was the only thing using it and the SPA doesn't need to fallback for it.

After this change, the denylist should only contain `/a/*` (one entry).

### 6. Update `unstream/CLAUDE.md` doc block

List the new edge function in the "edge functions" section. Remove the `claimed-artist-page` entry (UNS-104 will delete the file, but the doc should be consistent now).

## Important caveats

1. **The existing `claimed-artist-page.ts` MUST stay in `netlify.toml` until the new function is verified live.** The new function `artist-page-static.ts` should be added to a *different* route first, OR the old one should be removed in the same PR that the new one lands. Two valid options:
   - **Option A (cleaner):** Ship UNS-105 + UNS-104 in a single PR — add the new function, swap the route, delete the old file. Single deploy, no gap.
   - **Option B (safer for staged deploys):** Ship UNS-105 only, add the new function on a *different* path (e.g., `/a-static/*` for testing), verify it works on production, then in a separate deploy swap the route + delete the old file.

   **Default: Option A.** Same PR is fine because the deploy preview URL is the verification surface.

2. **The featured embed iframe is the XSS surface.** Whitelist domains match the SPA's `ALLOWED_EMBED_DOMAINS`. Default sandbox: `sandbox="allow-scripts allow-same-origin"`. **Dan reviews this part specifically** — XSS is the failure mode that breaks accessibility worse than no-JS at all.

3. **No JavaScript means no client-side error handling.** If Supabase is down, the edge function returns context.next() and the user gets the empty SPA shell. That's *worse* than the rich profile. Add a 5-second timeout to the Supabase fetch — fail fast, fall through to SPA. The SPA at least shows the `<NotFoundCard>` for not-found slugs.

## Definition of done

- [ ] `api/edge/artist-page-static.ts` deployed
- [ ] `netlify.toml` registers the new edge function for `/a/*` (replaces `claimed-artist-page`)
- [ ] `claimed-artist-page.ts` deleted (this is what couples UNS-105 + UNS-104)
- [ ] `vite.config.ts` `navigateFallbackDenylist` only contains `/a/*` (not `/artist/*`)
- [ ] `unstream/CLAUDE.md` edge functions list updated
- [ ] SPA's `index.html` `<noscript>` block covers the "browse the artist index" + "search for an artist" links (read first, don't duplicate)
- [ ] Build clean, tests pass
- [ ] `curl -s 'https://deploy-preview-NNN--unstream.netlify.app/a/kid-lightbulbs' | grep -c '<script' | grep -q 0` — zero `<script` tags in the static response
- [ ] `curl -s '.../a/kid-lightbulbs' | grep -q 'og:title'` — OG meta present
- [ ] `curl -s '.../a/kid-lightbulbs' | grep -q '"@type":"MusicGroup"'` — JSON-LD present
- [ ] XSS check on the embed iframe: only allowlisted domains can be embedded, iframe is sandboxed
- [ ] Dan's review (XSS check + no-JS verification)
- [ ] **Brandon's manual test on Safari 26 (deferred to UNS-107):** JS disabled → /a/{slug} → rich profile renders with all links working, embed iframe is sandboxed, no console errors. JS enabled → SPA still mounts and takes over.
- [ ] PR reviewed by Dan
- [ ] Sub-task moved to "Done" with the PR link
- [ ] Parent UNS-100 can be moved to Done once all sub-tasks (UNS-104, UNS-105, UNS-106, UNS-107, UNS-108) are Done

## Lane

- **Implementation:** Daryl
- **Review:** Dan (XSS check, no-JS verification, embed iframe sandbox)
- **Manual no-JS test:** Brandon (deferred to UNS-107)
- **Coordination:** Wayne
- **Spec written by:** Wayne
- **Approved by:** Brandon (pending)

## Out of scope

- Removing the service worker denylist entirely (that's a bigger discussion about PWA + accessibility tradeoffs)
- Server-side rendering for the artist directory page (`/artists`) — that's a separate accessibility consideration
- Caching the edge function response at the CDN layer — the data changes too frequently (claims, profile edits) and the latency is already low
- A static-HTML version of the directory page (UNS-105 is only for `/a/*`)
- Replacing `claimed-artist-page.ts` with anything other than `artist-page-static.ts` (no need for a third function)

## Risks (worth flagging in the PR body)

1. **No-JS users on slow networks** — the response is a single full HTML page (no chunked loading). For a rich profile with 10+ platform links, the page could be 50-100 KB. That's fine for 4G; could be slow on 2G. Acceptable trade-off.
2. **Static HTML doesn't update without a deploy** — if Brandon changes the `<RichArtistProfile>` component (CSS, layout), the static HTML drifts. Mitigation: keep the static HTML rendering as a manual port of the React component, not auto-generated. Document the drift risk in the PR.
3. **OG meta tag values** — the static HTML generates OG meta server-side. If the artist changes their bio, the OG description in the static HTML is stale until the next request. (Actually it's per-request, so this is fine — the edge function re-renders on every request.)
4. **The featured embed iframe is the XSS surface.** This is the part Dan reviews. Mitigation: allowlist domains, sandbox attribute, no `allow-scripts` if we can avoid it.
