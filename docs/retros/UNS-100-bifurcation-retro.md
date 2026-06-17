# UNS-100 retrospective: the MPA↔SPA bifurcation

**Date:** 2026-06-17
**Linear:** UNS-100 (closed 2026-06-17)
**Author:** Wayne
**Reviewers:** Brandon
**Severity:** Process lesson, not an incident. No production damage. But the symptom — a recurring bug loop on a single route dating back to May 31, with the active fix cycle (UNS-100 series) running roughly 2026-06-13 → 2026-06-17 — was real.

## TL;DR

`/a/{slug}` had two renderers — an edge function for claimed artists and the React SPA for unclaimed. Every bug fix for that route made things worse before they got better, because each fix was a partial revert of the previous fix. The only stable end state was: one route, one renderer.

**Rule (added to CLAUDE.md and AGENTS.md on 2026-06-17):** *one route, one renderer.* If a URL is server-rendered by an edge function, it is not also client-rendered by the SPA. Pick one.

## The bug loop (chronological)

| PR / issue | Date | What it tried to fix | What it actually did |
|---|---|---|---|
| UNS-94 (PR #264) | 2026-06-10 | `<Link to>` everywhere — SPA wins on direct visits | SPA-internal navigation worked, but rich profile was still in edge function → conflict on `/a/{slug}` (claimed) |
| UNS-98 (PR #268, never merged) | 2026-06-14 | Drop `/artists` edge function | Would have left `/a/*` dual-rendered (claimed → edge fn, unclaimed → SPA) |
| UNS-97 (PR #269) | 2026-06-14 | Drop `/artists` edge function (re-attempt) | Worked, but also reverted `<Link to>` back to `<a href>` → MPA↔SPA boundary restored, UNS-99 surfaced |
| UNS-99 (PR #271, hotfix) | 2026-06-14 | Targeted revert of the `<a href>` reversion | SPA-internal click back button worked, but UNS-97 (claimed artists showing search-result card) was back |
| UNS-71 (Done) | 2026-05-31 (PR #237) | Same symptom: back button broken | Fixed in isolation, regressed later when UNS-97 reverted the `<Link to>` |
| UNS-70 (Done) | 2026-05-31 (PR #236) | Same symptom: claimed artists showing search pages | Fixed in isolation, regressed later when UNS-97 restored the dual-renderer |
| UNS-73 (Done, no code change) | pre-2026-05-31 | Slow render of static pages | Closed as performance; the actual cause was the dual-renderer handoff cost |

**Pattern:** every fix moved the line somewhere else. None of them fixed the bifurcation.

## The UNS-100 series (the fix)

UNS-100 was the explicit decision: stop iterating on partial fixes, do the work to make the SPA the single renderer. Sub-tasks:

| Sub-task | What it did |
|---|---|
| UNS-101 (UNS-100a) | Extend `/api/artist-page` to return the full rich-profile payload |
| UNS-102 (UNS-100b) | Port the edge function layout to React as `<RichArtistProfile>` |
| UNS-103 (UNS-100c) | Rewrite `<ArtistPage>` to fetch from the new API and render `<RichArtistProfile>` for claimed, quiet layout for unclaimed |
| UNS-104 (UNS-100d) | Delete `claimed-artist-page.ts` edge function (the dual-renderer half) |
| UNS-105 (UNS-100e) | No-JS static HTML edge function for `/a/*` (accessibility fallback — pure SSR, no SPA conflict) |
| UNS-106 (UNS-100f) | `ClaimPage` post-claim redirect uses `navigate()` instead of `window.location.href` |
| UNS-108 (UNS-100h) | `<ArtistPage>` follow-ups: back-link, bfcache handling, footer blurb |
| UNS-107 (UNS-100g) | Brandon's manual Safari 26 verification |

**Key design choice:** UNS-105's no-JS fallback is *pure SSR with zero JavaScript*. It does not hydrate into a SPA. The SPA never tries to "take over" from the static page. They are two completely separate renderers for two completely separate use cases (in-app vs. external/crawler/no-JS) — not two renderers fighting over the same user.

**Key operational choice:** UNS-104 (delete the old edge function) shipped in the same PR as UNS-105 (replace it), so there was never a moment where `/a/*` had no renderer.

## Why the bifurcation was a bad design (the lesson)

Two systems trying to render the same URL creates three classes of bug:

1. **State divergence.** Edge function renders claimed artists only; SPA renders unclaimed only. User clicks a claimed artist from `/artists` → SPA's unclaimed code path fires → user sees "Found N results" chrome instead of rich profile. The two systems had to stay in sync about *who renders what*; they didn't.

2. **Back-button / bfcache breakage.** Browser back stack tracks URLs. Both renderers respond to `/a/{slug}`. When the SPA's client-side router fired a `<Link>` navigation, the URL updated but the edge function still owned the page. Hit back → browser loaded the *previous URL* from history, not the previous SPA-internal state → MPA reload from scratch every time.

3. **Fixes look like regressions.** Every fix to one renderer's behavior had to be matched in the other renderer's behavior, but the matching was implicit and easy to miss. UNS-94 added `<Link to>` everywhere → SPA won on direct visits → but rich profile was still in edge function → UNS-97 surfaced as a "regression" (it wasn't — it was the dual-renderer fighting back).

The structural problem: **you cannot converge two systems onto one behavior with one-system-at-a-time fixes.** Partial fixes don't compose. Each fix is a partial revert of the previous fix, and the system never settles.

## The rule and where it lives

**Rule:** *One route, one renderer.* If a URL is server-rendered by an edge function, it is not also client-rendered by the SPA. Pick one.

**Where the rule lives:**

- `CLAUDE.md` — "Engineering principles" section, as a new bullet. This is the canonical reference for code conventions and architectural decisions.
- `AGENTS.md` (workspace) — short pointer to the CLAUDE.md rule, so future agent sessions see it during red-lines review.
- This retro doc — the *why*, not the *what*. When someone asks "why does this codebase have this rule?" the answer is here.

## Watch-fors (next time the bifurcation temptation appears)

Several places in the codebase have *something like* this pattern. None are broken today, but they're worth keeping an eye on:

| URL pattern | Current state | Risk |
|---|---|---|
| `/guides/*` | `guide-page` edge function (pure SSR, no SPA conflict) | Low. Pure SSR, no JS, SPA doesn't try to take over. Safe. |
| `/search` | `noscript-search` edge function (no-JS fallback) | Low. Same as `/a/*` post-UNS-100 — pure SSR fallback, SPA doesn't fight it. |
| `/artists` | SPA only (post-UNS-98) | None. The edge function was deleted; SPA owns it. |
| `/dispatch.xml` | Build-time generated static file | None. Not a route; generated at build time. |
| `/login`, `/dashboard`, `/artist-edit/:slug` | SPA only | None. No edge functions compete. |

**The temptation that creates bifurcations:** "I need OG meta tags / no-JS fallback / SEO-friendly HTML, AND I need React." The answer is not "have both" — it's "have the static fallback for crawlers and no-JS users, have the SPA for in-app users, and *never let them overlap.*" UNS-105 got this right (zero JS in the response = no handoff conflict).

## What I'd do differently next time

**Stop iterating sooner.** UNS-100 should have been filed in March when the pattern was already clear (UNS-70, UNS-71, UNS-73 all had the same root cause). I waited until the loop was 4 cycles deep before scoping the systemic fix.

**Detect the pattern earlier.** A standing rule for me (Wayne): if 3+ bugs in the same area share a common root cause, file the structural fix as a separate issue immediately. Don't try to fix bug 4 with a partial revert when bugs 1-3 are already partial reverts of each other.

**Sequencing matters.** UNS-100 worked because UNS-104 (delete the dual renderer) shipped in the same PR as UNS-105 (replace it). Never leave a route with two renderers even briefly — that's when the partial fixes sneak back in.

## Artifacts and references

- Linear: UNS-100 (parent), UNS-101 through UNS-108, UNS-109 (route consolidation)
- PRs: #273, #274, #275, #276, #277, #278
- Specs: `docs/specs/UNS-103-artist-page-rewrite.md`, `docs/specs/UNS-105-no-js-static-edge-function.md`, `docs/specs/UNS-108-artist-page-followups.md`, `docs/specs/UNS-109-artist-route-consolidation.md`
- Related postmortems: `~/.openclaw/workspace/memory/postmortem-2026-06-07-pr256-merge-conflict.md` (different failure mode, but same theme: review processes need to catch structural problems, not just textual ones)
