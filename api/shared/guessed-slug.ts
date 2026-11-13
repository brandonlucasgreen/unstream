// Resolving an artist URL that was guessed from the artist's name.
//
// An artist's slug isn't always their name slugified. Same-name artists are stored under their
// Bandcamp account (`recordSlugs`), and claimed artists keep whatever slug they were claimed at,
// so Impulse Nine lives at /a/impulsenine. But clients, fans and other sites build URLs from the
// name: the Mac app's and extension's now-playing notifications did `slugify(name)` whenever a
// result had no claimed slug, which minted /a/impulse-nine. That URL had no row and no alias, so
// crawlers got the SPA shell answering 200 for "artist not found" — a soft 404 in Search Console
// (2026-11-12). 243 of 8,001 artists had a slug that differs from their name-derived one then.
//
// So after a live slug and an alias both miss, every reader of /a/:slug asks one more question:
// is this exactly one stored artist's name, slugified? If so, it redirects there. Several matches
// (Paracosm: Los Angeles, Orlando, Sofia) mean the name isn't evidence of which artist was meant,
// so nothing is picked and the URL stays a miss. Checked last, so a real artist who later takes
// the slug always wins, as with aliases.
//
// Pure helpers only, because Deno edge functions import this file as well as Node. Each caller
// runs the one query itself: `artists.select('slug, name').ilike('name', nameGuessPattern(slug))`.

import { artistSlug } from './artist-slug.ts';

/** How many candidate rows a guessed-slug lookup reads. A name shared by more than this is ambiguous anyway. */
export const GUESSED_SLUG_CANDIDATE_LIMIT = 10;

/**
 * An ILIKE pattern matching every name that could slugify to `slug`: its words, in order, joined
 * by anything. `impulse-nine` -> `impulse%nine`, which matches "Impulse Nine" and "Impulse-Nine".
 * Anchored at both ends (no leading or trailing %), as the slug is the whole name.
 *
 * Null for anything that can't be a slug. Slugs hold only [a-z0-9-], so the pattern carries no
 * `%`, `_` or quote of its own and is safe to hand to a PostgREST filter.
 *
 * Accented names aren't found this way ("bjork" isn't ILIKE "Björk"). The accent-folding reslug
 * left aliases for those (#410), which are checked before this.
 */
export function nameGuessPattern(slug: string): string | null {
  const lower = slug.toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(lower)) return null;
  return lower.split('-').join('%');
}

/**
 * The one artist whose name slugifies to `slug`, or null when none or several do.
 *
 * Both slugifications count: ours (`artistSlug`, accents folded) and the naive one the extension
 * and older clients use (`[^a-z0-9]+` -> `-`, accents dropped), since either may be what was
 * guessed.
 */
export function pickArtistForGuessedSlug(
  slug: string,
  candidates: { slug: string; name: string | null }[],
): string | null {
  const wanted = slug.toLowerCase();
  const matches = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.name || !candidate.slug) continue;
    if (artistSlug(candidate.name) === wanted || naiveSlug(candidate.name) === wanted) {
      matches.add(candidate.slug);
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function naiveSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
