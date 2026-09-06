---
status: Done
---
# UNS-103 — `<ArtistPage>` rewrite spec

**Sub-task of:** UNS-100 (collapse the MPA↔SPA bifurcation for `/a/{slug}`)
**Issue:** UNS-103, currently Backlog
**Owner:** Daryl
**Reviewer:** Dan
**Coordinator:** Wayne
**Status:** Blocked on PR #273 (UNS-102) merge

## Goal

Rewrite `apps/web/src/pages/ArtistPage.tsx` to use the new `/api/artist-page` endpoint (UNS-100a, PR #272, merged 2026-06-14) and the new `<RichArtistProfile>` component (UNS-100b, PR #273, in review). Drop the multi-branch `isClaimedArtist` ternary, the pre-generated JSON fallback, the dead search-bar branch, and the stale `useLocation` comment. After this lands, `<ArtistPage>` is a thin shell that fetches the payload and picks one of three components to render.

## What changes in the file

**Files:**
- `apps/web/src/pages/ArtistPage.tsx` — rewrite
- `apps/web/src/components/NotFoundCard.tsx` — new
- `apps/web/src/components/LoadingProfile.tsx` — new (or inline if <50 lines)
- `apps/web/src/components/UnclaimedQuietCard.tsx` — new
- `apps/web/src/components/MacAppPromo.tsx` — new (extracted from `ArtistPage.tsx:154-245` for reuse in `<NotFoundCard>`)
- `apps/web/src/components/RichArtistProfile.tsx` — small additions: `justClaimed`, `onSave`/`onUnsave`/`isSaved`/`disabledSave` props, save-button JSX, post-claim banner JSX
- `apps/web/tests/unit/ArtistPage.test.tsx` — new (covers the three render branches + loading + not-found)

**File size target:** `ArtistPage.tsx` <150 lines (currently 450).

**Removed from `ArtistPage.tsx`:**
- `isClaimedArtist = results.length === 1 && results[0].type === 'artist' && results[0].matchConfidence === 'claimed'` derivation (line 76) — replaced by `payload.profile?.verifiedAt` check.
- Multi-branch JSX ternary: `isClaimedArtist ? (...) : isProfileRoute && results.length > 0 ? (...) : results.length > 0 ? (...) : !error ? (...) : null` (lines 317, 327, ~400) — replaced by a single `if/else` chain over `(isLoading, notFound, payload, payload.profile)`.
- `/data/artists/{slug}.json` fetch (line 133) — `/api/artist-page` is the source of truth, no fallback.
- `useSearchParams` / `searchParams` / `justClaimed` post-claim banner logic (lines 24, 257) — *migrate* the banner into `<RichArtistProfile>` and `<UnclaimedQuietCard>` via a `justClaimed` prop. (Brandon is still in the post-claim flow and this UX matters.)
- `!isProfileRoute && !isClaimedArtist` branch showing the search bar (line 248) — **dead code**: `ArtistPage` is only mounted on `/a/:slug` and `/artist/:slug` per `main.tsx:72-73`, so `isProfileRoute` is always `true`. Remove the comment too.
- `useLocation` comment block (lines 19-22) — the `useLocation` import was already dropped in #269, only the stale comment survives. Clean up.
- `useAuth` / `handleSaveArtist` / `handleClaimShare` / `LoginInterstitial` — these still apply to the rich profile page. **Preserve**, wire to the new components via props or a thin context.
- `SearchBar` import (line 4) — unused after the dead branch goes.
- `ResultCard` import (line 5) — unused after the multi-branch render goes.
- `navigate` and `handleSearch` (line 152) — `SearchBar` is gone, no more programmatic search from this page.
- `macAppPromo` block (lines 154-245) — **drop entirely from `ArtistPage.tsx`**. Per Brandon (2026-06-15 15:16): the Mac app card is a search-results-page thing, doesn't belong on a clean profile. The `<NotFoundCard>` includes its own macAppPromo copy.
- `analytics.trackArtistPageView` call (line 88) — preserve, fire on slug change.

**No changes to these files:**
- `apps/web/src/main.tsx` — routes stay the same
- `apps/web/src/components/RichArtistProfile.tsx` — already ships the rich profile UI
- `api/edge/claimed-artist-page.ts` — still serves as the no-JS / OG-preview path **until UNS-100d** (don't touch it in this PR)
- `apps/web/vite.config.ts` — the `navigateFallbackDenylist` `/^\/a\//` entry stays until UNS-100d
- `apps/web/src/types/artist-page.ts` — type is already correct
- `apps/web/src/components/ClaimPage.tsx` — UNS-100f is a separate task (`window.location.href` → `navigate()`)

## The new shape (sketch)

```tsx
export function ArtistPage() {
  const { slug } = useParams<{ slug: string }>();
  const [payload, setPayload] = useState<ArtistPagePayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [searchParams] = useSearchParams();
  const justClaimed = searchParams.get('claimed') !== null;
  const { session, isArtistSaved, saveArtist, removeSavedArtist, loadSavedArtists } = useAuth();

  useEffect(() => {
    if (session) loadSavedArtists();
  }, [session]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setIsLoading(true);
    setNotFound(false);
    setPayload(null);
    fetch(`/api/artist-page?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: ArtistPagePayload | null) => {
        if (cancelled) return;
        if (data === null) setNotFound(true);
        else setPayload(data);
      })
      .catch(err => {
        if (cancelled) return;
        Sentry.captureException(err, { extra: { context: 'ArtistPage.fetchArtistPage', slug } });
        setNotFound(true);
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (slug) analytics.trackArtistPageView(slug);
  }, [slug]);

  // Update page title and meta tags from the payload's artist name
  useEffect(() => {
    if (payload?.artist.name) {
      document.title = `${payload.artist.name} on Bandcamp & alternative platforms | Unstream`;
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        const desc = payload.profile?.bio
          ? `${payload.artist.name} on Unstream — ${payload.profile.bio.slice(0, 160)}`
          : `${payload.artist.name} is on Bandcamp and other alternative platforms. Find direct links and support them outside streaming.`;
        metaDesc.setAttribute('content', desc);
      }
    }
    return () => { document.title = 'Unstream - Support artists directly'; };
  }, [payload?.artist.name, payload?.profile?.bio]);

  if (isLoading) return <LoadingProfile />;
  if (notFound || !payload) return <NotFoundCard slug={slug} />;
  if (payload.profile?.verifiedAt) {
    return <RichArtistProfile payload={payload} slug={slug!} justClaimed={justClaimed} />;
  }
  return <UnclaimedQuietCard payload={payload} slug={slug!} justClaimed={justClaimed} />;
}
```

## Component specs

### `<LoadingProfile>` (new)

- Spinner + "Loading profile…" copy
- Same visual treatment as the current `isLoading` branch (line ~298)
- Can be a 10-line inline component if simpler than a separate file
- **Test:** renders without throwing, has the spinner

### `<NotFoundCard>` (new)

- 404-style message: "We couldn't find that artist"
- Link back to `/artists`
- **Include the macAppPromo** (per Brandon 2026-06-15 15:16): the dead-end becomes a soft redirect to the Mac app / browser extension. Reuse the existing macAppPromo JSX (lines 154-245 of current `ArtistPage.tsx`) — copy into a new `<MacAppPromo>` component in `apps/web/src/components/MacAppPromo.tsx` and import in `<NotFoundCard>`.
- Sentry should already have caught the API error in the parent `catch` (no need to re-capture here).
- **Test:** renders the link to `/artists`, shows the slug in the message, renders the MacAppPromo

### `<UnclaimedQuietCard>` (new)

- Simplified `<RichArtistProfile>`:
  - **Same:** hero (image, name, location), platform links, social links, "Powered by Unstream" footer
  - **Different:** no bio, no featured embed, no verified badge, no payout annotations on platform links, no embed-widget section, no "Save" button hover state
  - **Plus:** a soft inline nudge "Are you {Name}? [Claim this profile →]" linking to `/claim?slug={slug}`. This is the primary CTA for unclaimed profiles.
- **Test:** renders name + platform links, hides bio/embed/verified-badge, shows claim nudge

### `<RichArtistProfile>` (already exists, UNS-102)

- Add a `justClaimed?: boolean` prop. When true, render a dismissible green banner above the hero: "🎉 You're verified! Welcome to Unstream." with a small ✕ to dismiss (local state).
- Add `onSave?: () => void`, `onUnsave?: () => void`, `isSaved?: boolean`, and `disabledSave?: boolean` props so the parent (`ArtistPage`) wires the auth-aware save button from `useAuth()`. **Per Brandon (2026-06-15 15:16):** save button goes on the rich profile, same Save/Unsave UI as the unclaimed card. Keeps the component pure (no `useAuth` import inside).
- Save button placement: in the hero, next to the artist name / verified badge row, right-aligned. (Top of the page, not bottom-of-card.)

## State and side effects

- **Loading skeleton** during API fetch (currently the page is a blank screen for ~1-2s)
- **404** on API 404 (artist doesn't exist) or network error (caught + Sentry)
- **Title + meta** updates from `payload.artist.name` and `payload.profile?.bio`
- **Analytics** `trackArtistPageView(slug)` on slug change (preserve existing behavior)
- **No Sentry.captureException** for the normal 404 case — only for actual network errors / 5xx
- **No retry** — the user can refresh or click the back link

## Out of scope (other UNS-100 sub-tasks)

- UNS-100a (API contract `/api/artist-page`) — **Done**, PR #272
- UNS-100b (`<RichArtistProfile>`) — **In review**, PR #273
- UNS-100d (delete `claimed-artist-page` edge function + drop `/a/*` from `navigateFallbackDenylist`) — depends on this PR
- UNS-100e (no-JS fallback) — depends on this PR
- UNS-100f (`ClaimPage.tsx:299` `window.location.href` → `navigate()`) — separate PR

## Definition of done

- [ ] `ArtistPage.tsx` is <150 lines (currently 450)
- [ ] `/a/{slug}` for a claimed artist → `<RichArtistProfile>` (rich layout, bio, embed, payout annotations, embed-widget section, verified badge, save button)
- [ ] `/a/{slug}` for an unclaimed artist with a Wikidata record → `<UnclaimedQuietCard>` (name, image, platform links, claim nudge, **no** bio/embed/verified/payout-annotations)
- [ ] `/a/{slug}` for a not-found slug → `<NotFoundCard>` with a link back to `/artists`
- [ ] `/a/{slug}?claimed=1` shows the post-claim banner on the relevant render branch
- [ ] No more `useLocation` import or comment block
- [ ] No more pre-generated JSON fetch
- [ ] No more `SearchBar` / `ResultCard` imports in this file
- [ ] No more `isClaimedArtist` derivation
- [ ] No more `useNavigate` / `handleSearch` (the search bar is gone)
- [ ] No more dead `!isProfileRoute && !isClaimedArtist` branch
- [ ] Page title and meta description use the payload
- [ ] `analytics.trackArtistPageView` still fires on slug change
- [ ] `npm run build` clean (tsc + vitest + vite + sitemap)
- [ ] `npm run test:unit` 280+/280+ (262 + ~18 new for `ArtistPage.test.tsx`, `<UnclaimedQuietCard>`, `<NotFoundCard>`)
- [ ] Manual test on Safari 26: `/artists` → click → `/a/{slug}` → back button → `/artists` (no MPA boundary, no bfcache bug) — UNS-99 regression check
- [ ] Manual test: direct visit `/a/{slug}` for a claimed artist renders identically to the current edge function output — UNS-97 regression check
- [ ] Dan's review APPROVE
- [ ] Sub-task moved to "Done" with the PR link

## Open questions for Brandon (block on answer before implementation)

1. **Save button location.** Currently `<RichArtistProfile>` (UNS-102) has no save button. The unclaimed card has one. Should the rich profile get a save button too, or should the CTA on a claimed profile be different (e.g., follow / share)?
   - **Answered (2026-06-15 15:16 EDT):** ✅ Add the save button to `<RichArtistProfile>`. Same Save/Unsave UI as the unclaimed card. Wire via `onSave` / `onUnsave` / `isSaved` prop trio (parent passes auth-aware values from `useAuth()`).
2. **macAppPromo on profile pages.** Was this intentionally shown on `/a/{slug}`? The old code path was `!isProfileRoute && !isClaimedArtist` so it was hidden for claimed profiles. Now that `ArtistPage` is always a profile route, does the promo show, or is this an oversight to clean up?
   - **Answered (2026-06-15 15:16 EDT):** ❌ Drop the Mac app card totally from the profile page. Remove the import, the JSX, and the related state. The macAppPromo was a search-results page thing; doesn't belong on a clean profile.
3. **`<NotFoundCard>` chrome.** Should it be a minimal 404, or include the macAppPromo / search bar so the user has somewhere to go next?
   - **Answered (2026-06-15 15:16 EDT):** Include the Mac app promo there. NotFoundCard is the user's "wrong turn" landing — give them a way to discover the Mac app / browser extension so the dead-end becomes a soft redirect to a real product.
4. **Post-claim banner placement.** Confirm the banner should appear above the rich profile / quiet card hero, not as a toast at the bottom of the page.
   - **Answered (2026-06-15 15:16 EDT):** ✅ Above the hero. Inline. Green. "🎉 You're verified! Welcome to Unstream." with ✕ dismiss.

## Lane

* **Implementation:** Daryl
* **Review:** Dan
* **Coordination:** Wayne
* **Verification:** Brandon (manual Safari 26 testing on macOS Tahoe and iOS 26)

## Why a separate spec doc from the issue body

The Linear issue body has the high-level plan but is short on specifics: it doesn't pin the API endpoint to use, doesn't address the `justClaimed` banner migration, doesn't enumerate the components to create, and doesn't list the open questions. This spec doc is the implementation source of truth; the issue body stays as the user-facing summary.
