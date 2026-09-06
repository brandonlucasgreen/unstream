---
status: Done
---
# UNS-109 — Replace legacy `/artist/*` edge fn with `artist-page-static`; remove Login from static header

**Linear:** [UNS-109](https://linear.app/cultoflightbulbs/issue/UNS-109)
**Spec body:** UNS-109 issue description (this doc is the working expansion for the implementer)
**Parent:** UNS-105 (the static edge function)
**Closes the loop on:** UNS-104 (the `/artist/*` retirement open question) + the follow-up comment I posted on UNS-105 asking whether to retire `/artist/*`
**Owner:** Daryl
**Reviewer:** Brandon (via Claude Code — Dan review intentionally skipped this round)
**Coordinator:** Wayne
**Status:** Ready for Daryl

## Why this exists

Production smoke test of PR #277 surfaced two header issues on the static artist pages:

1. **Auth-bar inconsistency on `/artist/{slug}`** — the legacy `artist-page` edge function renders a static "Login" link AND an inline-JS auth bar that unhides itself by reading `localStorage`. Logged-in users see *both at once*: a "Logged in as you@…" bar AND a "Login" link in the nav. Two competing header elements.
2. **"Login" link is misleading on `/a/{slug}`** — `artist-page-static` always shows "Login", but per the public-page framing (these are artist flyers for external audiences, not in-app navigation), a Login affordance is wrong anyway. Anyone who needs the app uses the footer "Index" link or browser back.

The root cause: **the SPA's auth-aware nav is for in-app navigation. Static artist pages are content, not app.** Mixing the two is the bug.

### The fix in two sentences

Swap the renderer behind `/artist/*` to use the same static edge function as `/a/*`, then delete the legacy `artist-page` edge function. URLs don't change (no SEO impact, no redirects), the renderer does.

## What to build

### 1. `netlify.toml` — repoint `/artist/*` to `artist-page-static`

**One-line change at line 17.**

```toml
[[edge_functions]]
path = "/artist/*"
function = "artist-page-static"   # was: "artist-page"
```

**Important: do not delete the `[[edge_functions]]` block.** Keep the routing, just point it at the new function. URLs (`/artist/all-time-low`, etc.) stay the same — no 301s, no SEO migration, no broken external links.

### 2. `api/edge/artist-page-static.ts` — remove the Login link from both header branches

The header is identical structure in both the claimed and unclaimed branches:

```ts
<header class="site-header">
  <a href="/" class="brand">${LOGO_SVG} Unstream</a>
  <div class="nav-right">
    <a href="/login" class="nav-link">Login</a>   // ← remove this line
  </div>
</header>
```

**Two changes (both occurrences):**

- **Claimed branch** (around line 278): remove the `<a href="/login" class="nav-link">Login</a>` line.
- **Unclaimed branch** (around line 381): same — remove the `<a href="/login" class="nav-link">Login</a>` line.

**Also clean up:** once the Login link is gone, the `<div class="nav-right">` wrapper becomes an empty div. Remove the wrapper too in both branches. The header should simplify to:

```ts
<header class="site-header">
  <a href="/" class="brand">${LOGO_SVG} Unstream</a>
</header>
```

**Don't add anything else.** No Dashboard link, no auth-aware rendering, no Supabase cookie work. Per Brandon's framing, the static page is a content page; the footer already has Index/Roadmap/Support/Privacy/Donate for anyone who wants to navigate into the app.

**Don't remove the existing CSS classes** (`.site-header`, `.brand`, `.nav-right`) — they're harmless and removing them isn't in scope. Just don't *use* `.nav-right` anymore. If you want to strip the unused class from the CSS, do it in a follow-up; not this PR.

### 3. Delete `api/edge/artist-page.ts` (393 lines)

The legacy edge function. After this change, nothing references it. Delete the file outright.

**Why we can delete it safely:**
- The new `artist-page-static` is a strict superset: it handles both claimed AND unclaimed artists (the old function only handled claimed), and the URL `/artist/*` is now routed to it.
- All test coverage for the old function transfers to `artist-page-static` (which already shipped with 316/322 tests passing in #277).
- The old function's only unique feature that `artist-page-static` lacks is the theme toggle and the auth localStorage reader — both removed by design (see "What we lose" below).

**Sanity-check before deleting:** `grep -rn "artist-page\b" --include="*.ts" --include="*.toml" --include="*.md"` should return zero hits after this PR. Run it locally to confirm.

### 4. `CLAUDE.md` — update the edge functions list

There's a doc block in `CLAUDE.md` listing the edge functions. Find the line that mentions `artist-page` (the legacy one) and remove it. The `artist-page-static` entry should already be there from #277 — verify.

## What we lose (and why that's fine)

The legacy `artist-page.ts` has three things `artist-page-static` doesn't:

| Legacy feature | Why we lose it | User impact |
|---|---|---|
| Theme toggle (JS-driven) | `artist-page-static` uses `prefers-color-scheme` CSS media query — same behavior, no JS | None. The page still respects dark/light mode at the OS level. Users who *manually* toggle can't on this page, but they're not going to since they're coming from a link share. |
| Auth localStorage reader + auth-bar | Per Brandon's framing: public artist pages are content, not app | None for the public-page audience. In-app users navigate via SPA routes, which already use `useAuth()` correctly. |
| `<div id="root">` mount point | The SPA doesn't hydrate from this page anyway | None. Static page renders fully without React. |

## Routing priority — nothing else changes

`netlify.toml` order matters. After this change:

```toml
[[edge_functions]]
path = "/"
function = "og-metadata"

[[edge_functions]]
path = "/artist/*"
function = "artist-page-static"

[[edge_functions]]
path = "/a/*"
function = "artist-page-static"

[[edge_functions]]
path = "/search"
function = "noscript-search"

[[edge_functions]]
path = "/guides/*"
function = "guide-page"
```

Both `/artist/*` and `/a/*` route to the same function. The URL still works, the SEO still works, the rendering is unified. Netlify edge function matching is path-based, so a request to `/artist/all-time-low` matches the `/artist/*` rule; a request to `/a/all-time-low` matches the `/a/*` rule. No overlap.

## Why I'm not doing the Supabase-auth-cookie approach

Three options considered for the "always shows Login" issue:

| Option | Scope | Status |
|---|---|---|
| **A.** Add Supabase auth cookie + edge fn reads it | Big: client cookie writes, server session lookup, signing key management | Rejected for this workstream. The auth cookie is a product decision (do we want cookies at all? GDPR implications? UX of unexpected sign-in on shared computers?) and pairs naturally with future server-side auth work. |
| **B.** Add a tiny inline JS snippet in `artist-page-static` that reads localStorage and swaps the Login link (mirrors what `/artist/*` does today) | Small | Rejected. UNS-105's spec explicitly forbids JS in the response ("zero JS, per Brandon's no-JS accessibility principle"). Adding JS to fix an auth-state display issue violates the spec. Also inherits the confusing "two header elements" UX. |
| **C.** Remove the Login link entirely, leave the static page as content | Smallest | **Chosen.** Per Brandon's framing: public artist pages are content, not app. The footer already provides Index/Roadmap/Support/Privacy/Donate. Anyone who needs the app uses those. |

## Acceptance criteria

### Code

- [ ] `netlify.toml:17` swapped from `function = "artist-page"` to `function = "artist-page-static"`
- [ ] `api/edge/artist-page-static.ts` Login link removed in both claimed (~line 278) and unclaimed (~line 381) branches
- [ ] `api/edge/artist-page-static.ts` empty `<div class="nav-right">` wrapper removed in both branches
- [ ] `api/edge/artist-page.ts` deleted (393 lines)
- [ ] `CLAUDE.md` edge functions list no longer mentions `artist-page` (legacy)
- [ ] `grep -rn "artist-page\b" --include="*.ts" --include="*.toml" --include="*.md"` returns zero hits for the legacy reference (the `artist-page-static` references should remain)
- [ ] Build clean
- [ ] All unit tests pass (316/322 expected, same 6 search-accuracy flakes as main — no regressions)

### Curl verification (deploy preview)

```bash
# 1. Same HTML structure on both URLs (modulo claimed/unclaimed differences)
curl -s https://deploy-preview-NNN--unstream.netlify.app/artist/all-time-low -o /tmp/artist.html
curl -s https://deploy-preview-NNN--unstream.netlify.app/a/all-time-low -o /tmp/a.html
diff <(grep -v 'canonical\|og:url' /tmp/artist.html) <(grep -v 'canonical\|og:url' /tmp/a.html)
# → should be empty or near-empty (differences limited to claimed/unclaimed markup)

# 2. No "Login" or "Dashboard" affordances in static header
for path in /a/all-time-low /artist/all-time-low; do
  curl -s "https://deploy-preview-NNN--unstream.netlify.app${path}" | \
    grep -iE 'login|sign.?in|dashboard|auth-bar' && echo "FAIL: ${path}" || echo "PASS: ${path}"
done
# → both should print PASS

# 3. No executable <script> tags (only JSON-LD allowed)
for path in /a/all-time-low /artist/all-time-low; do
  count=$(curl -s "https://deploy-preview-NNN--unstream.netlify.app${path}" | \
    grep -c '<script' | grep -v 'application/ld+json')
  echo "${path}: ${count} executable scripts (must be 0)"
done

# 4. Footer still has Index/Roadmap/Support for in-app navigation
curl -s https://deploy-preview-NNN--unstream.netlify.app/a/all-time-low | grep -E '/artists|/login|/privacy-policy'
# → should still find /login and /artists in the footer (not the header)
```

### Browser smoke test

| State | Step | Expected |
|---|---|---|
| Logged out | Direct visit `https://unstream.stream/a/all-time-low` | Brand on left, no Login link in header, footer has Index/Roadmap/etc. Click "Index" → SPA loads, SPA shows Login link in header |
| Logged out | Direct visit `https://unstream.stream/artist/all-time-low` | Same as above |
| Logged in | Direct visit `https://unstream.stream/a/all-time-low` | Brand on left, no Login link in header (this is the *fix* — no false "Login" affordance), footer has Index. Click "Index" → SPA loads, SPA shows email + Dashboard + Sign out |
| Logged in | Direct visit `https://unstream.stream/artist/all-time-low` | Same as above |
| Either | Direct visit a slug that doesn't exist (e.g. `/a/nonexistent-slug`) | Edge function returns `context.next()`, SPA shell renders (`<div id="root">` present). Same as before — no regression. |

### Pre-merge checks

- [ ] Pre-review protocol: `git fetch origin && git diff origin/main..HEAD --stat` — check for deletions in files modified in the last 7 days. Should be clean (we're deleting a legacy file, but it's in `api/edge/` which hasn't been touched recently).
- [ ] Semantic-revert bot: should fire for `api/edge/artist-page.ts` deletion, since it was last modified recently. That's expected — confirm the deletion is intentional in the PR description.
- [ ] Daryl runs `deslop` skill on the branch diff before opening the PR (AGENTS.md red line). Strip any AI-style noise from the diff.
- [ ] Netlify deploy preview builds clean
- [ ] All curl verifications pass
- [ ] Manual browser smoke test on a claimed + unclaimed artist slug, both logged-in and logged-out

### Post-merge

- [ ] `data/shipped-features.json` entry added: `{ id: "UNS-109", title: "Unified /artist/* renderer + removed Login link from public artist pages", description: "...", date: "YYYY-MM-DD", announced: false }`
- [ ] UNS-109 closed with PR link
- [ ] Verify `https://unstream.stream/artist/all-time-low` in production after merge — should match `/a/all-time-low` structurally

## Definition of done

- [ ] All code/curl/browser criteria above checked off
- [ ] PR opened with the 4 file changes listed
- [ ] PR reviewed by Brandon (via Claude Code)
- [ ] PR merged
- [ ] Production smoke test confirms `/artist/*` and `/a/*` both render the new static header
- [ ] `data/shipped-features.json` updated
- [ ] UNS-109 closed

## Out of scope (explicitly)

- Supabase auth cookie (Option A above) — separate, larger piece of work
- Adding any auth-aware rendering to static pages — explicitly rejected for this workstream
- Changing URL structure (e.g. moving `/artist/*` to `/a/*` with redirects) — explicit decision to keep URLs
- `<noscript>` block changes in `apps/web/index.html` — already covered by UNS-105
- Removing unused CSS classes (`.nav-right`, etc.) — cleanup, not this PR
- Any changes to `<RichArtistProfile>` or the SPA's auth-aware nav — those work correctly today, don't touch
