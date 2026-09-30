// The bio shown under an artist's name on search and detection results.
//
// What's worth locking: that a found-somewhere bio is only shown when it's actually prose (a
// booking email isn't a bio), that a short real bio isn't hidden for being short, and that the
// artist's own words always win over a third party's.

import { describe, it, expect } from 'vitest';
import {
  BIO_MAX_CHARS,
  capBio,
  cleanDiscogsProfile,
  isUsableBio,
  makeBio,
  normalizeBioWhitespace,
  pickBio,
} from '../../shared/artist-bio';

describe('isUsableBio', () => {
  it('accepts a short real bio — there is no length minimum', () => {
    expect(isUsableBio('Noise duo from Leeds.')).toBe(true);
  });

  it('rejects contact-only and link-only text', () => {
    expect(isUsableBio('booking: agent@example.com')).toBe(false);
    expect(isUsableBio('https://instagram.com/band\nhttps://twitter.com/band')).toBe(false);
    expect(isUsableBio('www.band.com @bandname')).toBe(false);
  });

  it('rejects emoji and one-word bios', () => {
    expect(isUsableBio('🎸🔥')).toBe(false);
    expect(isUsableBio('Band.')).toBe(false);
  });

  it('counts a bio in a script written without spaces', () => {
    expect(isUsableBio('東京出身のスリーピースバンド')).toBe(true);
  });

  it('lets a promo line through — it is still the artist talking', () => {
    expect(isUsableBio('new album out now!')).toBe(true);
  });
});

describe('normalizeBioWhitespace', () => {
  it('collapses whitespace inside paragraphs and keeps paragraph breaks', () => {
    expect(normalizeBioWhitespace('  One   line\nwrapped.\r\n\r\n\n Second  para. '))
      .toBe('One line wrapped.\n\nSecond para.');
  });
});

describe('cleanDiscogsProfile', () => {
  it('keeps named references, drops id-only ones, unwraps links and formatting', () => {
    expect(cleanDiscogsProfile('Formed by [a=Kim Gordon] [a12345] on [l=Matador Records]. See [url=https://example.com]their site[/url]. [b]Loud[/b].'))
      .toBe('Formed by Kim Gordon on Matador Records. See their site. Loud.');
  });
});

describe('capBio', () => {
  it('leaves a short bio alone', () => {
    expect(capBio('Short.')).toEqual({ text: 'Short.', truncated: false });
  });

  it('cuts a long bio on a word boundary and says so', () => {
    const long = 'word '.repeat(400).trim();
    const capped = capBio(long);
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBeLessThanOrEqual(BIO_MAX_CHARS + 1);
    expect(capped.text.endsWith('word…')).toBe(true);
  });
});

describe('makeBio', () => {
  it('returns null without a source URL — every bio links to where it came from', () => {
    expect(makeBio('bandcamp', 'A real bio about a band.', null)).toBeNull();
  });

  it('shows anything a claimed artist wrote, even one word', () => {
    expect(makeBio('unstream', 'Noise.', 'https://unstream.stream/a/x')?.text).toBe('Noise.');
  });

  it('holds found-elsewhere text to the usability rule', () => {
    expect(makeBio('bandcamp', 'contact: a@b.co', 'https://x.bandcamp.com')).toBeNull();
  });

  it('cleans Discogs markup before judging it', () => {
    expect(makeBio('discogs', '[a=Sonic Youth] side project from New York.', 'https://www.discogs.com/artist/1')?.text)
      .toBe('Sonic Youth side project from New York.');
  });
});

describe('pickBio', () => {
  it('takes the first candidate that exists', () => {
    const bandcamp = makeBio('bandcamp', 'The artist in their own words.', 'https://x.bandcamp.com');
    const wikipedia = makeBio('wikipedia', 'An encyclopedia article about them.', 'https://en.wikipedia.org/wiki/X');
    expect(pickBio([null, bandcamp, wikipedia])?.source).toBe('bandcamp');
    expect(pickBio([null, undefined])).toBeNull();
  });
});
