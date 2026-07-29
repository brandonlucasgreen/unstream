/**
 * The site-wide default page title.
 *
 * Pages that set their own `document.title` restore this on unmount, so it was
 * previously copy-pasted into five files and drifted out of date. Import it
 * instead of hardcoding the string.
 *
 * Keep in sync with the `<title>` and `og:title` in `apps/web/index.html` (the
 * static shell crawlers and social scrapers read, before React mounts) and with
 * the assertion in `test-save-api.sh` that checks a page is NOT the generic SPA.
 */
export const DEFAULT_PAGE_TITLE =
  'Unstream - Find the best places online to directly support the music artists you love';
