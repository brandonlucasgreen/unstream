---
status: Done
---
# UNS-108 — `<ArtistPage>` follow-ups: back-link, bfcache, footer

**Sub-task of:** UNS-100 (collapse the MPA↔SPA bifurcation for `/a/{slug}`)
**Sibling:** UNS-103 (rewrite shipped for review, feedback from PR #274 deploy preview)
**Owner:** Daryl
**Reviewer:** Dan
**Coordinator:** Wayne
**Status:** Ready for Daryl

## Context

Brandon reviewed the deploy preview for PR #274 and flagged three things, all surfaced on the same render path (`/artists` → click → `/a/{slug}`). All three are visible on the **claimed** branch (`<RichArtistProfile>`), not the unclaimed branch, so the unclaimed cards are unaffected. Filed screenshot 2026-06-16 08:12 EDT.

## Issue 1 — "Back to artists" link is awkward

**Where:** `apps/web/src/pages/ArtistPage.tsx:99-110`

The link is the first child of `<main className="px-4 pb-16">`. Header has `p-4` and `border-b`. The link has only `mb-4`, so it sits flush against the header border in the screenshot — the spacing reads as overlapping the header. The link also only makes sense as a workaround for the broken browser-back button (Issue 2). Once back works, the explicit link can be dropped.

**Fix:**
- **Remove** the `<Link to="/artists">...</Link>` from `ArtistPage.tsx` entirely.
- The `<NotFoundCard>` keeps its own "Browse artists" link — that's still useful on a 404. No change there.

## Issue 2 — Browser back button broken after `/artists` → `/a/{slug}`

**Where:** `apps/web/src/pages/ArtistPage.tsx` (whole file) and `apps/web/src/components/Header.tsx`

The directory page uses React Router `<Link to={`/a/${slug}`}>` so navigation is push-history. The back button should work natively. It doesn't, which means something on the artist page is breaking Safari 26's bfcache eligibility — when the back button restores a bfcached page, Safari falls back to a full reload, and *if the previous page's listener or fetch is still in flight* the back nav appears to "not work."

The most likely culprits, in order:

1. **`document.title` / `meta` mutation in `useEffect` cleanup.** The title effect (lines 73-87) does mutate the DOM and tries to clean up. Cleanup returns the title to a string — that part looks fine. But there's no `pageshow` handler, so on bfcache restore the cleanup may have already run, leaving a stale title until the next effect fires. **Verify with a manual test first**; if confirmed, gate the DOM mutation on a `pageshow` listener and use a ref to avoid the stale state on restore.
2. **`loadSavedArtists` in `AuthContext` (line 41-44 in `AuthContext.tsx`) has no cleanup.** The `useEffect` in `ArtistPage` calls `loadSavedArtists()` on session change but doesn't abort an in-flight request when the component unmounts during the back-nav. If the auth context's `getSession()` or `waitForMagicLinkSession()` fetch is still pending when the user hits back, the artist page won't fully tear down. **Add an `AbortController` to the `useAuth` fetch on unmount.**
3. **`Header.tsx` `useEffect` for `/api/admin/verify`** (lines 41-58 in Header.tsx) has no abort on unmount. If the admin is the visitor, the request can outlive the page. **Add `AbortController` here too.** Non-admins skip this branch (early return) so it's only a problem for admins browsing the artist page.

**Fix in priority order:**
1. Add `pageshow` handler in `ArtistPage` (and ideally globally in `App.tsx`) that detects `event.persisted === true` and skips the title/meta reset on bfcache restore. Pattern:
   ```tsx
   useEffect(() => {
     function onPageShow(e: PageTransitionEvent) {
       if (e.persisted) {
         // bfcache restore — don't re-run title/meta mutation
         return;
       }
     }
     window.addEventListener('pageshow', onPageShow);
     return () => window.removeEventListener('pageshow', onPageShow);
   }, []);
   ```
2. Add `AbortController` to the `useAuth` session-init fetch and to the Header's admin-verify fetch so they cancel on unmount.
3. **Verify on Safari 26** (Brandon's manual test setup) before declaring it fixed.

**Important:** Do NOT switch to `<a href>` for the directory links. The whole point of UNS-99 was keeping the SPA navigation so bfcache can kick in. The bug is on the *destination* page, not the source.

## Issue 3 — Remove "Powered by Unstream" footer blurb from `<RichArtistProfile>` and `<UnclaimedQuietCard>`

**Where:**
- `apps/web/src/components/RichArtistProfile.tsx:338-350`
- `apps/web/src/components/UnclaimedQuietCard.tsx:182-194`

Both render the same block at the bottom:

```tsx
<div className="py-6 px-4 text-center">
  <a href="https://unstream.stream" className="text-text-primary no-underline font-bold text-lg">
    Powered by Unstream
  </a>
  <p className="text-sm text-text-muted mt-1">
    Find music on platforms that pay artists fairly.
  </p>
</div>
```

Brandon's call: now that the unified `<Header>` is rendered above, the footer blurb is redundant noise. Remove the whole block from both files.

**Test impact:** Check `RichArtistProfile.test.tsx` and `UnclaimedQuietCard.test.tsx` for tests that assert the "Powered by Unstream" text or a related query. If any, update them to assert the blurb is absent.

## Files to change

- `apps/web/src/pages/ArtistPage.tsx` — remove "Back to artists" Link; add pageshow handler; verify AbortController for fetch
- `apps/web/src/contexts/AuthContext.tsx` — add AbortController to the session-init fetch
- `apps/web/src/components/Header.tsx` — add AbortController to the admin-verify fetch
- `apps/web/src/components/RichArtistProfile.tsx` — remove the "Powered by Unstream" block
- `apps/web/src/components/UnclaimedQuietCard.tsx` — remove the "Powered by Unstream" block
- `apps/web/tests/unit/RichArtistProfile.test.tsx` — drop/update "Powered by Unstream" assertion if present
- `apps/web/tests/unit/UnclaimedQuietCard.test.tsx` — drop/update "Powered by Unstream" assertion if present

## Out of scope

- Switching to `<a href>` for navigation (would break UNS-99, which was the original bfcache fix)
- Touching `<NotFoundCard>`'s "Browse artists" link — that one is correct as-is
- Touching `<Footer>` (the global footer) — separate concern from the per-page "Powered by Unstream" blurb
- Header layout or visual changes — out of scope for this issue

## Definition of done

- [ ] "Back to artists" link removed from `ArtistPage.tsx`
- [ ] `<NotFoundCard>` still has its "Browse artists" link (no change)
- [ ] `pageshow` handler added to handle bfcache restore correctly
- [ ] `AbortController` added to `useAuth` session-init fetch
- [ ] `AbortController` added to `Header.tsx` admin-verify fetch
- [ ] "Powered by Unstream" block removed from `<RichArtistProfile>`
- [ ] "Powered by Unstream" block removed from `<UnclaimedQuietCard>`
- [ ] Existing tests updated to match (or new tests for the removals)
- [ ] `npm run build` clean, `npm test` green
- [ ] **Brandon's manual test on Safari 26:** `/artists` → click → `/a/kid-lightbulbs` → browser back returns to `/artists` instantly, no MPA flash, title preserved
- [ ] PR reviewed by Dan
- [ ] Deploy preview confirmed working
- [ ] Sub-task moved to "Done" with the PR link

## Lane

- **Implementation:** Daryl
- **Review:** Dan
- **Manual Safari 26 verification:** Brandon
- **Coordination:** Wayne
