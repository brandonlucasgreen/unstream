import { describe, it, expect } from 'vitest';
import {
  normalizeAccents,
  normalizeSearchQuery,
  normalizeForComparison,
  namesMatch,
  textMatchScore,
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
