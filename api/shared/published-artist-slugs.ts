// The artist slugs Unstream itself publishes.
//
// `data/artists-manifest.json` is what feeds the sitemap and the generated social posts
// (scripts/generate-sitemap.ts, scripts/generate-social-posts.ts), so it is exactly the set of
// /artist/:slug URLs we hand to Google and put in posts. A 404 on one of these is never a fan
// typing a name wrong — it's us advertising a URL that doesn't work, which is how the Funkadelic
// bug (#380) reached a social post before anyone noticed.
//
// Imported as JSON rather than read from disk: Netlify bundles a function's imports, but files
// merely present in the repo aren't included at runtime.

import manifest from '../../data/artists-manifest.json';

const publishedSlugs = new Set<string>(
  (manifest as Array<{ slug?: string }>)
    .map(entry => entry.slug)
    .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0)
);

/** True if we publish /artist/{slug} — i.e. a 404 for it is our bug, not a bad guess by a fan. */
export function isPublishedArtistSlug(slug: string): boolean {
  return publishedSlugs.has(slug.toLowerCase());
}

/** Count of published slugs. Exposed so a test can catch the manifest failing to load at all. */
export function publishedArtistSlugCount(): number {
  return publishedSlugs.size;
}
