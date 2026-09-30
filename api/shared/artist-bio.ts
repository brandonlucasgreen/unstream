// The short artist bio shown on search and detection results.
//
// One bio, one source, never stitched together. Sources in priority order — the artist's
// own words first, third parties after (docs/specs/artist-bio-excerpt-spec.md):
//
//   1. unstream  — the claimed profile's bio, written at /artist-edit/:slug
//   2. bandcamp  — the sidebar bio on a Bandcamp page we already fetched and trust
//   3. discogs   — the `profile` field of the Discogs artist API response we already fetch
//   4. wikipedia — the REST summary extract, found via MusicBrainz → Wikidata
//
// The server picks; clients only render. Implementing the choice three times (Swift, the
// extension, React) is how the rules would drift apart.
//
// Plain text only. Clients render `text` as text, never as HTML, so a bio can't carry markup.

export type BioSource = 'unstream' | 'bandcamp' | 'discogs' | 'wikipedia';

export interface ArtistBio {
  /** Plain text. Paragraphs are separated by a blank line. */
  text: string;
  source: BioSource;
  /** Where the full bio lives — always present, it is the "read more" link. */
  sourceUrl: string;
  /** The server cap cut the text, so clients say "read more" rather than implying it's whole. */
  truncated: boolean;
}

/** Long enough for any real excerpt; clients clamp to a few lines anyway. */
export const BIO_MAX_CHARS = 1000;

/** Normalize whitespace while keeping paragraph breaks. */
export function normalizeBioWhitespace(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
    .filter(paragraph => paragraph.length > 0)
    .join('\n\n');
}

// Scripts written without spaces between words, where a word count means nothing.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Whether a bio says anything about the artist.
 *
 * Plenty of real Bandcamp bios aren't empty but aren't bios either — "booking: x@y.com", a
 * column of links, an emoji. So links, emails and @handles are removed first, and what's left
 * must hold at least three words. There is deliberately no length minimum: a short real bio
 * like "Noise duo from Leeds." is shown (decided 2026-09-30). Short promo lines ("new album out
 * now!") get through too, which is fine — it's still the artist talking.
 */
export function isUsableBio(text: string): boolean {
  const prose = text
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/(^|\s)@\w[\w.]*/g, ' ');

  const words = prose.split(/\s+/).filter(token => /\p{L}/u.test(token));
  if (words.length >= 3) return true;

  // "東京出身のスリーピースバンド" is one whitespace token and a perfectly good bio.
  if (UNSPACED_SCRIPT.test(prose)) {
    const letters = prose.match(/\p{L}/gu) ?? [];
    return letters.length >= 6;
  }
  return false;
}

/** Cut to BIO_MAX_CHARS on a word boundary. */
export function capBio(text: string): { text: string; truncated: boolean } {
  if (text.length <= BIO_MAX_CHARS) return { text, truncated: false };
  const slice = text.slice(0, BIO_MAX_CHARS);
  const lastSpace = slice.search(/\s\S*$/);
  const cut = lastSpace > BIO_MAX_CHARS * 0.8 ? slice.slice(0, lastSpace) : slice;
  return { text: `${cut.replace(/[\s,;:.-]+$/, '')}…`, truncated: true };
}

/**
 * Turn Discogs profile markup into plain text.
 *
 * Discogs profiles use BBCode-ish tags: [a=Name] / [l=Label] name an artist or label inline,
 * [a123] / [l123] / [r123] / [m123] reference one by id (no readable name, so dropped),
 * [url=…]text[/url] is a link, [b] [i] [u] are formatting.
 */
export function cleanDiscogsProfile(profile: string): string {
  return profile
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[(?:a|l)=([^\]]+)\]/gi, '$1')
    .replace(/\[[almr]\d+\]/gi, '')
    .replace(/\[\/?(?:b|i|u|s)\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1');
}

/** Build a bio from raw text, or null when the text isn't usable. */
export function makeBio(source: BioSource, rawText: string | null | undefined, sourceUrl: string | null | undefined): ArtistBio | null {
  if (!rawText || !sourceUrl) return null;
  const text = normalizeBioWhitespace(source === 'discogs' ? cleanDiscogsProfile(rawText) : rawText);
  // A claimed artist wrote their bio for this exact spot, so anything non-empty is theirs to
  // show. The usability check is for text we found somewhere else.
  if (source === 'unstream' ? text.length === 0 : !isUsableBio(text)) return null;
  const capped = capBio(text);
  return { text: capped.text, source, sourceUrl, truncated: capped.truncated };
}

/** The first usable bio, given candidates already in priority order. */
export function pickBio(candidates: (ArtistBio | null | undefined)[]): ArtistBio | null {
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return null;
}
