import { describe, it, expect } from 'vitest';
import {
  generateResultId,
  extractPlatformIdentifier,
  isQobuzVariation,
  isSearchOnlyLink,
  qobuzDisplayName,
} from '../../../../api/functions/search-utils';

describe('generateResultId', () => {
  it('generates consistent IDs for same input', () => {
    const id1 = generateResultId('Matt Young');
    const id2 = generateResultId('Matt Young');
    expect(id1).toBe(id2);
  });

  it('generates different IDs for different names', () => {
    expect(generateResultId('Matt Young')).not.toBe(generateResultId('Kid Lightbulbs'));
  });

  it('normalizes for comparison', () => {
    expect(generateResultId('Matt Young')).toBe(generateResultId('matt young'));
  });

  it('includes artist when provided', () => {
    expect(generateResultId('Album Name', 'Artist')).not.toBe(generateResultId('Album Name'));
  });
});

describe('extractPlatformIdentifier', () => {
  it('extracts Bandcamp subdomain', () => {
    expect(extractPlatformIdentifier('https://corymiller.bandcamp.com', 'bandcamp')).toBe('corymiller');
    expect(extractPlatformIdentifier('https://mattyoungmusictx.bandcamp.com', 'bandcamp')).toBe('mattyoungmusictx');
  });

  it('extracts Qobuz artist ID', () => {
    expect(extractPlatformIdentifier('https://www.qobuz.com/us-en/interpreter/cory-miller/496181', 'qobuz')).toBe('496181');
  });

  it('returns pathname for other platforms', () => {
    expect(extractPlatformIdentifier('https://mirlo.space/artist/123', 'mirlo')).toBe('/artist/123');
  });
});

describe('isQobuzVariation', () => {
  it('matches exact name', () => {
    expect(isQobuzVariation('mattyoung', 'mattyoung')).toBe(true);
  });

  it('matches name + numeric suffix', () => {
    expect(isQobuzVariation('mattyoung1', 'mattyoung')).toBe(true);
    expect(isQobuzVariation('mattyoung2', 'mattyoung')).toBe(true);
    expect(isQobuzVariation('morice2', 'morice')).toBe(true);
  });

  it('rejects non-numeric suffixes', () => {
    expect(isQobuzVariation('mattyoungmusic', 'mattyoung')).toBe(false);
  });

  it('rejects unrelated names', () => {
    expect(isQobuzVariation('matthias', 'mattyoung')).toBe(false);
  });
});

describe('isSearchOnlyLink', () => {
  it('identifies Ko-fi and BuyMeACoffee as search-only', () => {
    expect(isSearchOnlyLink({ sourceId: 'kofi', url: 'https://example.com' })).toBe(true);
    expect(isSearchOnlyLink({ sourceId: 'buymeacoffee', url: 'https://example.com' })).toBe(true);
  });

  it('identifies Ampwall search URLs as search-only', () => {
    expect(isSearchOnlyLink({
      sourceId: 'ampwall',
      url: 'https://ampwall.com/explore?searchStyle=search&query=test',
    })).toBe(true);
  });

  it('does not flag Ampwall API results', () => {
    expect(isSearchOnlyLink({
      sourceId: 'ampwall',
      url: 'https://ampwall.com/artist/test',
    })).toBe(false);
  });

  it('does not flag real platform links', () => {
    expect(isSearchOnlyLink({ sourceId: 'bandcamp', url: 'https://test.bandcamp.com' })).toBe(false);
    expect(isSearchOnlyLink({ sourceId: 'qobuz', url: 'https://qobuz.com/test' })).toBe(false);
  });
});

describe('qobuzDisplayName', () => {
  it('extracts display name from Qobuz URL slug', () => {
    expect(qobuzDisplayName('https://www.qobuz.com/us-en/interpreter/matt-young/123', 'fallback'))
      .toBe('Matt Young');
    expect(qobuzDisplayName('https://www.qobuz.com/us-en/interpreter/kid-lightbulbs/456', 'fallback'))
      .toBe('Kid Lightbulbs');
  });

  it('returns fallback when URL has no interpreter pattern', () => {
    expect(qobuzDisplayName('https://qobuz.com/other', 'fallback')).toBe('fallback');
  });
});
