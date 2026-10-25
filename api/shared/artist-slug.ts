// How an artist's name becomes their slug, shared by the server (api/functions/db.ts re-exports
// `artistSlug`) and the web client, which needs the same answer for a claim link. One copy on
// purpose: the web card once rebuilt slugs with its own ASCII-stripping regex, so Björk's claim
// link pointed at /claim/bj-rk while the server's row was `bjork` (audit 2026-10-25 #6).
//
// Pure string functions, no imports, so Node, Deno and the browser can all load this file.

// Normalize accented characters to their ASCII equivalents
// e.g., "Tanerélle" -> "Tanerelle", "Björk" -> "Bjork"
export function normalizeAccents(str: string): string {
  // Unicode NFD normalization decomposes accented characters
  // e.g., "é" becomes "e" + combining acute accent
  // Then we remove the combining diacritical marks (U+0300 to U+036F)
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Latin letters Unicode NFD does **not** decompose, and their ASCII equivalents.
 *
 * NFD only splits a base letter from a combining mark. A letter with the stroke or slash baked
 * into the codepoint has nothing to split off, so `normalizeAccents` leaves it untouched and any
 * `[^a-z0-9]` pass downstream then deletes it or turns it into a separator. Measured 2026-08-03:
 *
 *   "Błoto"  -> b-oto     (ł survives NFD, becomes a hyphen)
 *   "Nørden" -> n-rden
 *   "Łukasz" -> ukasz     (the first letter disappears entirely)
 *   "Æther"  -> ther
 *
 * Deliberately a short, explicit list of the letters that actually turn up in artist names rather
 * than a transliteration library — every entry here is one a human can read and check.
 */
const NON_DECOMPOSING_LATIN: Record<string, string> = {
  ø: 'o', Ø: 'O',
  ł: 'l', Ł: 'L',
  đ: 'd', Đ: 'D',
  ð: 'd', Ð: 'D',
  þ: 'th', Þ: 'Th',
  æ: 'ae', Æ: 'Ae',
  œ: 'oe', Œ: 'Oe',
  ß: 'ss',
  ħ: 'h', Ħ: 'H',
  ŋ: 'n', Ŋ: 'N',
  ı: 'i',
  ŧ: 't', Ŧ: 'T',
};

/**
 * Fold a name to ASCII: decompose what NFD can, transliterate what it can't.
 *
 * Use this wherever a name becomes an identifier a human will see or type — a URL slug above all.
 * `normalizeAccents` alone is not enough there; see NON_DECOMPOSING_LATIN.
 *
 * Deliberately NOT used by `normalizeForComparison`, which keys the Bandcamp probe cache
 * (`query_norm`) and every in-memory match map. Widening that would shift existing cache keys and
 * silently change which names count as the same artist — a separate, riskier change.
 */
export function foldToAscii(str: string): string {
  return normalizeAccents(str).replace(
    /[øØłŁđĐðÐþÞæÆœŒßħĦŋŊıŧŦ]/g,
    c => NON_DECOMPOSING_LATIN[c] ?? c,
  );
}

/**
 * Generate a URL-safe slug from an artist name.
 *
 * Accents are **folded, not stripped**. The old version ran the raw name through
 * `[^a-z0-9]+ -> '-'`, which mangled every accented artist into something unfindable:
 *
 *   Björk             -> bj-rk               (now bjork)
 *   Sébastien Tellier -> s-bastien-tellier   (now sebastien-tellier)
 *   Hüsker Dü         -> h-sker-d            (now husker-du)
 *   Łukasz            -> ukasz               (now lukasz — the Ł used to vanish outright)
 *
 * Fans reported being unable to find accented artists, and it was worse than an ugly URL: the
 * mangled form is what `persistSearchResults` upserts `on conflict (slug)`, so an artist typed with
 * accents and one typed without produced two rows and two half-populated pages.
 *
 * **Changing this changes what an existing artist's slug computes to**, which is why
 * `artist_slug_aliases` exists — a row whose stored slug is the old mangled form has to be
 * re-slugged and its old slug aliased, or the next search creates a third row. See
 * `scripts/merge-duplicate-artists.ts` and migration 20260803180000.
 */
export function artistSlug(name: string): string {
  return foldToAscii(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
