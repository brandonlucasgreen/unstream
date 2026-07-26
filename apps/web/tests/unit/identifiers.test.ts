import { describe, it, expect } from 'vitest';
import {
  generateResultId,
  extractPlatformIdentifier,
  isSearchOnlyLink,
  displayNameFromSlug,
  pickQobuzUrl,
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

  it('returns pathname for other platforms', () => {
    expect(extractPlatformIdentifier('https://mirlo.space/artist/123', 'mirlo')).toBe('/artist/123');
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

describe('displayNameFromSlug', () => {
  it('reconstructs a display name from a URL slug', () => {
    expect(displayNameFromSlug('matt-young')).toBe('Matt Young');
    expect(displayNameFromSlug('kid-lightbulbs')).toBe('Kid Lightbulbs');
  });

  it('strips trailing numeric disambiguation suffixes', () => {
    expect(displayNameFromSlug('ben-g-1')).toBe('Ben G');
  });

  it('prefers the original query when it normalizes to the same name', () => {
    expect(displayNameFromSlug('ben-g', 'Ben-G!')).toBe('Ben-G!');
  });
});

// MusicBrainz relations are the only source of Qobuz links now that the search scrape
// is retired, so this picker is the whole of Qobuz coverage.
// See docs/specs/qobuz-coverage-research.md.
describe('pickQobuzUrl', () => {
  it('returns null when no relation is a Qobuz URL', () => {
    expect(pickQobuzUrl([])).toBeNull();
    expect(pickQobuzUrl(['https://radiohead.bandcamp.com', 'https://mirlo.space/x'])).toBeNull();
  });

  it('picks the www.qobuz.com interpreter page', () => {
    expect(pickQobuzUrl([
      'https://radiohead.bandcamp.com',
      'https://www.qobuz.com/us-en/interpreter/radiohead/43840',
    ])).toBe('https://www.qobuz.com/us-en/interpreter/radiohead/43840');
  });

  it('prefers www.qobuz.com over open.qobuz.com regardless of order', () => {
    // MusicBrainz stores both shapes for the same artist (e.g. Aphex Twin).
    const wwwUrl = 'https://www.qobuz.com/us-en/interpreter/aphex-twin/53267';
    const openUrl = 'https://open.qobuz.com/artist/53267';
    expect(pickQobuzUrl([openUrl, wwwUrl])).toBe(wwwUrl);
    expect(pickQobuzUrl([wwwUrl, openUrl])).toBe(wwwUrl);
  });

  it('falls back to open.qobuz.com when that is all MusicBrainz has', () => {
    expect(pickQobuzUrl(['https://open.qobuz.com/artist/53267']))
      .toBe('https://open.qobuz.com/artist/53267');
  });

  it('ignores unparseable URLs instead of throwing', () => {
    expect(pickQobuzUrl(['not a url', 'https://www.qobuz.com/us-en/interpreter/x/1']))
      .toBe('https://www.qobuz.com/us-en/interpreter/x/1');
  });

  it('does not match lookalike hostnames', () => {
    expect(pickQobuzUrl(['https://qobuz.com.evil.example/artist/1'])).toBeNull();
  });
});
