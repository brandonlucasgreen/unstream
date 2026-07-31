import { describe, it, expect } from 'vitest';

// The bug this guards: MusicBrainz is Lucene-backed, and the artist search used to send
// an unquoted field term — `artist:viagra boys`. Lucene reads that as `artist:viagra` OR
// a bare `boys`, so the loose token pulls in whichever popular artist matches it best.
// Measured against the live API on 2026-07-31:
//
//   artist:viagra boys    -> "The Beach Boys" (score 100)  <- wrong artist wins
//   artist:"viagra boys"  -> "Viagra Boys"    (score 100)
//
// The wrong hit is then correctly rejected by the downstream name-similarity guard, so
// the artist silently loses ALL enrichment (official site, socials, Discogs, location,
// and Qobuz, which MB is now the only source of) and the search returns nothing.
//
// On a 20-artist sample from data/artists-manifest.json, 4 got the wrong top hit
// unquoted and quoting fixed all 4. 543 of ~790 catalog artists are multi-word.

import { musicBrainzArtistQuery } from '../search-utils';

describe('musicBrainzArtistQuery', () => {
  it('wraps multi-word names in a Lucene phrase', () => {
    // The regression itself: without the quotes this is `artist:viagra boys`.
    expect(musicBrainzArtistQuery('viagra boys')).toBe('artist:"viagra boys"');
    expect(musicBrainzArtistQuery('Ian McDonald')).toBe('artist:"Ian McDonald"');
    expect(musicBrainzArtistQuery('the mountain goats')).toBe('artist:"the mountain goats"');
  });

  it('quotes single-word names too, so there is one code path', () => {
    expect(musicBrainzArtistQuery('Radiohead')).toBe('artist:"Radiohead"');
  });

  it('preserves case and accents for the phrase', () => {
    // Callers normalize accents upstream where they want to; this helper must not
    // silently change the term it is handed.
    expect(musicBrainzArtistQuery('Tanerélle')).toBe('artist:"Tanerélle"');
    expect(musicBrainzArtistQuery('Sigur Rós')).toBe('artist:"Sigur Rós"');
  });

  it('strips quotes and backslashes that would break out of the phrase', () => {
    // A stray `"` would terminate the phrase and turn the remainder into loose
    // tokens — reintroducing the exact bug. A trailing `\` would escape the
    // closing quote.
    expect(musicBrainzArtistQuery('Bar "Nine" Trio')).toBe('artist:"Bar Nine Trio"');
    expect(musicBrainzArtistQuery('AC\\DC')).toBe('artist:"AC DC"');
    expect(musicBrainzArtistQuery('trailing\\')).toBe('artist:"trailing"');
  });

  it('collapses whitespace so stripping cannot leave doubled spaces', () => {
    expect(musicBrainzArtistQuery('  Big   Thief  ')).toBe('artist:"Big Thief"');
    expect(musicBrainzArtistQuery('a "" b')).toBe('artist:"a b"');
  });

  it('keeps punctuation Lucene does not treat as phrase-breaking', () => {
    // Inside a quoted phrase these are literal, and stripping them would loosen
    // the match for no reason.
    expect(musicBrainzArtistQuery('Ben-G!')).toBe('artist:"Ben-G!"');
    expect(musicBrainzArtistQuery('Godspeed You! Black Emperor'))
      .toBe('artist:"Godspeed You! Black Emperor"');
  });

  it('produces a URL-safe value once encoded', () => {
    // The call sites encodeURIComponent the whole thing; the quotes must survive
    // as %22 rather than being dropped.
    expect(encodeURIComponent(musicBrainzArtistQuery('viagra boys')))
      .toBe('artist%3A%22viagra%20boys%22');
  });
});
