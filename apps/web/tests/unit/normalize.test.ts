import { describe, it, expect } from 'vitest';
import {
  normalizeAccents,
  normalizeSearchQuery,
  normalizeForComparison,
  namesMatch,
  textMatchScore,
} from '../../../../api/functions/search-utils';

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
