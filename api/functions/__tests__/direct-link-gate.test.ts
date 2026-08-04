// What `isDirectLink` lets into artist_links.
//
// It reads like a labelling helper and is easy to mistake for one, but `persistSearchResults`
// filters on it (`db.ts`: `!EXCLUDED_PLATFORMS.has(p.sourceId) && isDirectLink(p.url)`), so it
// decides whether a link gets a row at all. That makes it the last check standing between a
// synthesised search URL and every downstream consumer that assumes a stored link is a real
// destination — including the release crawler, which derives `/music` from it and fetches.
//
// The gap it had: `bandcamp.com/search` was not on the list, so 189 placeholder rows were
// written and later crawled as artist pages, 404ing every time (#407).

import { describe, it, expect } from 'vitest';
import { isDirectLink } from '../db';

describe('isDirectLink — what reaches artist_links', () => {
  it.each([
    ['a Bandcamp search placeholder', 'https://bandcamp.com/search?q=Mount%20Eerie'],
    ['the same with different casing', 'https://BandCamp.com/Search?q=Mount%20Eerie'],
    ['a Ko-fi DuckDuckGo fallback', 'https://duckduckgo.com/?q=site:ko-fi.com+Artist'],
    ['a Google search', 'https://google.com/search?q=Artist'],
    ['the Ampwall explore fallback', 'https://ampwall.com/explore?searchStyle=search&query=Artist'],
    ['the BuyMeACoffee explore page', 'https://buymeacoffee.com/explore-creators'],
    ['the Subvert discover template', 'https://www.subvert.fm/discover?q=Mount%20Eerie&type=artist'],
    ['the same without www', 'https://subvert.fm/discover?q=Absurd&type=artist'],
  ])('rejects %s', (_label, url) => {
    expect(isDirectLink(url)).toBe(false);
  });

  it('keeps real Subvert artist pages while rejecting the discover template', () => {
    // The gate has to split one platform in two, so pin both halves. 349 Subvert links are
    // stored: 321 are the discover template (source 'search'), and 28 are real artist pages that
    // artists added themselves (source 'claimed'). Rejecting the platform outright would have
    // deleted those 28 — which is why this matches on the /discover path, not on the host.
    expect(isDirectLink('https://www.subvert.fm/discover?q=Coca%E2%80%90Cola&type=artist')).toBe(false);
    expect(isDirectLink('https://www.subvert.fm/discover?type=artist&q=Spectrum')).toBe(false);
    expect(isDirectLink('https://www.subvert.fm/kid-lightbulbs')).toBe(true);
    expect(isDirectLink('http://subvert.fm/valoy')).toBe(true);
  });

  it.each([
    ['a bare artist subdomain', 'https://melondruie.bandcamp.com'],
    ['an album page', 'https://warrenharrison.bandcamp.com/album/some-record'],
    ['a /music page', 'https://nixienoise.bandcamp.com/music'],
    ['a Bandcamp Pro custom domain', 'https://music.sufjan.com'],
    ['a Mirlo artist page', 'https://mirlo.space/warren-harrison'],
    ['a Discogs artist page', 'https://www.discogs.com/artist/4861285'],
  ])('accepts %s', (_label, url) => {
    expect(isDirectLink(url)).toBe(true);
  });

  it('does not reject an artist whose own domain contains the word search', () => {
    // The check is substring-based, so it is worth pinning that it keys on the Bandcamp host
    // and path together rather than the bare word — an artist site could legitimately be called
    // this, and silently dropping their link would be invisible.
    expect(isDirectLink('https://searchparty.bandcamp.com')).toBe(true);
    expect(isDirectLink('https://research.example.com')).toBe(true);
  });
});
