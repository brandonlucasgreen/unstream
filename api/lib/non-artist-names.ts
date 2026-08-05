// Names that are not musical acts, and must never become an artist row.
//
// `persistSearchResults` creates a row for anything the search pipeline calls an artist, and the
// pipeline's default verdict is `verified` (search-utils.ts `splitSuspiciousPlatforms`), so a
// software product with a Beatport listing and a MusicBrainz entry lands in "Artists You Know"
// alongside real musicians. `/artist/chatgpt` was exactly that: MusicBrainz holds a "ChatGPT"
// artist whose official site is chatgpt.com, and one search minted a permanent page for it.
//
// Deleting the row is not enough on its own — the next search for the same term recreates it.
// This list is what makes a removal stick.
//
// Scope is deliberately narrow. An entry belongs here only when the entity itself is not a
// musical act and the stored evidence proves it — a corporate official site, the company's own
// social accounts, a broadcaster's page. A *name collision* is not grounds for an entry: there
// are real independent artists on Bandcamp called "American Express", "masterclass", "Now
// Playing" and "Seoul Metro", all releasing real records, and blocking them would remove exactly
// the artists Unstream exists to surface. When in doubt, leave the name off this list.
//
// Keys are `artistSlug()` output, so they match however a source spells or punctuates the name.
// To reverse an entry, delete the line — the artist reappears on the next uncached search.

export const NON_ARTIST_SLUGS = new Set([
  // OpenAI's product. The MusicBrainz entry's official site is chatgpt.com and there is no
  // Bandcamp, Mirlo or Faircamp presence of any kind.
  'chatgpt',
  // NBC television show. Stored official site nbc.com/saturday-night-live, plus facebook/snl,
  // instagram/nbcsnl and the SNL YouTube channel — the broadcaster's own accounts.
  'saturday-night-live',
  // LANDR Audio Inc., an audio-mastering SaaS. The stored Instagram is the company's
  // (instagram.com/landr.music); the PeerTube "match" was a channel called landrover.
  'landr',
  // The beverage brand. Qobuz and Discogs listings only, no direct-purchase presence anywhere.
  'coca-cola',
]);

/**
 * Is this slug a known non-musical entity?
 *
 * Takes `artistSlug()` output rather than a raw name so the normalization stays in one place —
 * accent folding and punctuation stripping already live there.
 */
export function isNonArtistSlug(slug: string): boolean {
  return NON_ARTIST_SLUGS.has(slug);
}
