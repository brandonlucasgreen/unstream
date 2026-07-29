import { describe, it, expect } from 'vitest';
import {
  normalizeAccents,
  normalizeSearchQuery,
  normalizeForComparison,
  namesMatch,
  namesEqualIgnoringArticles,
  looksLikeOpaqueId,
  textMatchScore,
  collectMbSuggestions,
  bandcampSlugCandidates,
} from '../../../../api/functions/search-utils';

describe('bandcampSlugCandidates', () => {
  it('generates base, strip-"the", and hyphenated variants in that order', () => {
    // Order matters: recall is 66.3% / 69.3% / 71.1% cumulative, so the base
    // slug must be probed first.
    expect(bandcampSlugCandidates('The Beths')).toEqual(['thebeths', 'beths', 'the-beths']);
  });

  it('collapses duplicates when variants coincide', () => {
    // No leading "the", single word -> base and strip-"the" are identical.
    expect(bandcampSlugCandidates('Radiohead')).toEqual(['radiohead']);
  });

  it('stops at three candidates', () => {
    expect(bandcampSlugCandidates('The Mountain Goats').length).toBeLessThanOrEqual(3);
  });

  it('normalizes accents so Björk reaches bjork', () => {
    expect(bandcampSlugCandidates('Björk')).toEqual(['bjork']);
  });

  it('only strips a leading "the", not one mid-name', () => {
    const candidates = bandcampSlugCandidates('Explosions in the Sky');
    expect(candidates[0]).toBe('explosionsinthesky');
    expect(candidates).not.toContain('explosionsinsky');
  });

  it('drops candidates under three characters', () => {
    // Bandcamp subdomains are at least 3 chars, so a 2-char guess is wasted work.
    expect(bandcampSlugCandidates('U2')).toEqual([]);
  });

  it('handles punctuation and ampersands without emitting empty segments', () => {
    const candidates = bandcampSlugCandidates('King Gizzard & The Lizard Wizard');
    expect(candidates[0]).toBe('kinggizzardthelizardwizard');
    expect(candidates.every(c => !c.startsWith('-') && !c.endsWith('-'))).toBe(true);
    expect(candidates.every(c => !c.includes('--'))).toBe(true);
  });

  it('returns nothing for input with no alphanumerics', () => {
    expect(bandcampSlugCandidates('!!! ???')).toEqual([]);
  });
});

describe('normalizeAccents', () => {
  it('removes accents from characters', () => {
    expect(normalizeAccents('Tanerélle')).toBe('Tanerelle');
    expect(normalizeAccents('Björk')).toBe('Bjork');
    expect(normalizeAccents('José González')).toBe('Jose Gonzalez');
  });

  it('passes through ASCII strings unchanged', () => {
    expect(normalizeAccents('Matt Young')).toBe('Matt Young');
    expect(normalizeAccents('Radiohead')).toBe('Radiohead');
  });
});

describe('normalizeSearchQuery', () => {
  it('removes accents but preserves spaces and punctuation', () => {
    expect(normalizeSearchQuery('Tanerélle')).toBe('Tanerelle');
    expect(normalizeSearchQuery('Four Tet')).toBe('Four Tet');
  });
});

describe('normalizeForComparison', () => {
  it('lowercases and strips non-alphanumeric characters', () => {
    expect(normalizeForComparison('Kid Lightbulbs!')).toBe('kidlightbulbs');
    expect(normalizeForComparison('Matt Young')).toBe('mattyoung');
    expect(normalizeForComparison('The Black Keys')).toBe('theblackkeys');
  });

  it('handles accented characters', () => {
    expect(normalizeForComparison('Tanerélle')).toBe('tanerelle');
    expect(normalizeForComparison('Björk')).toBe('bjork');
  });

  // Regression guard: hand-rolling this as `.toLowerCase().replace(/[^a-z0-9]/g, '')`
  // *deletes* the accented letter rather than folding it, which silently broke MusicBrainz
  // name matching for every accented artist — MB's "Tanerélle" became "tanerlle" while the
  // already-normalized query was "tanerelle", so enrichment (and the Qobuz link) was dropped.
  // Always call normalizeForComparison; never reimplement it inline.
  it('folds accents rather than deleting them, unlike a naive charclass strip', () => {
    const naive = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    expect(naive('Tanerélle')).toBe('tanerlle');            // the trap
    expect(normalizeForComparison('Tanerélle')).toBe('tanerelle'); // correct
    expect(normalizeForComparison('Tanerélle')).toBe(normalizeForComparison('Tanerelle'));
  });

  it('handles empty and whitespace-only strings', () => {
    expect(normalizeForComparison('')).toBe('');
    expect(normalizeForComparison('   ')).toBe('');
  });
});

describe('namesMatch', () => {
  it('matches identical names', () => {
    expect(namesMatch('Kid Lightbulbs', 'Kid Lightbulbs')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(namesMatch('kid lightbulbs', 'Kid Lightbulbs')).toBe(true);
  });

  it('matches when one contains the other', () => {
    expect(namesMatch('Kid Lightbulbs', 'Kid Lightbulbs Music')).toBe(true);
    expect(namesMatch('Kid Lightbulbs Music', 'Kid Lightbulbs')).toBe(true);
  });

  it('rejects clearly different names', () => {
    expect(namesMatch('Radiohead', 'Coldplay')).toBe(false);
    expect(namesMatch('Four Tet', 'Aphex Twin')).toBe(false);
  });

  it('matches similar names via fuzzy matching (known behavior)', () => {
    // namesMatch uses contains + character similarity, so similar names can match
    expect(namesMatch('Cory Miller', 'Dory Miller')).toBe(true);
  });
});

describe('textMatchScore', () => {
  it('returns 3 for exact match', () => {
    expect(textMatchScore('Kid Lightbulbs', 'kid lightbulbs')).toBe(3);
  });

  it('returns 2 for starts-with match', () => {
    expect(textMatchScore('Kid Lightbulbs Music', 'kid lightbulbs')).toBe(2);
  });

  it('returns 1 for contains match', () => {
    expect(textMatchScore('The Kid Lightbulbs', 'kid lightbulbs')).toBe(1);
  });

  it('returns 0 for no match', () => {
    expect(textMatchScore('Radiohead', 'kid lightbulbs')).toBe(0);
  });
});

describe('namesEqualIgnoringArticles', () => {
  it('matches names differing only by a leading article', () => {
    expect(namesEqualIgnoringArticles('Argent Grub', 'The Argent Grub')).toBe(true);
    expect(namesEqualIgnoringArticles('The Beths', 'Beths')).toBe(true);
    expect(namesEqualIgnoringArticles('A Perfect Circle', 'Perfect Circle')).toBe(true);
  });

  it('matches identical names', () => {
    expect(namesEqualIgnoringArticles('Kid Lightbulbs', 'kid lightbulbs')).toBe(true);
  });

  it('rejects substring relationships that are different artists', () => {
    // This is why namesMatch is NOT used for name-only attachment.
    expect(namesEqualIgnoringArticles('Argent', 'Rod Argent')).toBe(false);
    expect(namesEqualIgnoringArticles('Argent', 'The Argent Grub')).toBe(false);
  });

  it('does not treat "The..." as part of a longer word', () => {
    // "Theresa" must not become "resa".
    expect(namesEqualIgnoringArticles('Theresa', 'resa')).toBe(false);
  });

  it('rejects empty names', () => {
    expect(namesEqualIgnoringArticles('The', 'A')).toBe(false);
  });
});

describe('looksLikeOpaqueId', () => {
  it('flags hex account ids like Bandwagon fallback handles', () => {
    expect(looksLikeOpaqueId('695d15c12f0f56fdced0a5e6')).toBe(true);
    expect(looksLikeOpaqueId('@695d15c12f0f56fdced0a5e6')).toBe(true);
  });

  it('flags long numeric ids', () => {
    expect(looksLikeOpaqueId('123456789')).toBe(true);
  });

  it('does not flag real artist slugs', () => {
    expect(looksLikeOpaqueId('the-argent-grub')).toBe(false);
    expect(looksLikeOpaqueId('kidlightbulbs')).toBe(false);
    expect(looksLikeOpaqueId('ben-g')).toBe(false);
    // Short hex-looking words are usually words.
    expect(looksLikeOpaqueId('decade')).toBe(false);
  });
});

describe('collectMbSuggestions', () => {
  // Real MB response shape for the query "argent" (2026-07).
  const argentArtists = [
    { name: 'Argent', score: 100 },
    { name: 'Rod Argent', score: 88 },
    { name: 'Argent', score: 78 },
    { name: 'Argent', score: 78 },
    { name: 'Goodnight Argent', score: 72 },
  ];

  it('suggests partial-name matches beyond the top hit', () => {
    expect(collectMbSuggestions(argentArtists, 'argent', 'Argent'))
      .toEqual(['Rod Argent', 'Goodnight Argent']);
  });

  it('excludes the query itself and the enriched artist', () => {
    const suggestions = collectMbSuggestions(argentArtists, 'argent', 'Argent');
    expect(suggestions).not.toContain('Argent');
  });

  it('drops low-scored hits', () => {
    expect(collectMbSuggestions([{ name: 'Argent Something', score: 50 }], 'argent')).toEqual([]);
  });

  it('drops hits whose name does not contain the query', () => {
    expect(collectMbSuggestions([{ name: 'The Zombies', score: 90 }], 'argent')).toEqual([]);
  });

  it('dedupes by normalized name and caps at 4', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `Argent ${i}`, score: 90 }));
    expect(collectMbSuggestions(many, 'argent')).toHaveLength(4);
    expect(collectMbSuggestions([
      { name: 'Rod Argent', score: 90 },
      { name: 'ROD ARGENT', score: 85 },
    ], 'argent')).toEqual(['Rod Argent']);
  });

  it('returns nothing for an empty query', () => {
    expect(collectMbSuggestions(argentArtists, '!!!')).toEqual([]);
  });
});
