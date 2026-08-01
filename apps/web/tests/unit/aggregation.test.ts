import { describe, it, expect } from 'vitest';
import {
  aggregateResults,
  mergeStoredArtistsIntoResults,
  type PlatformResult,
  type AggregatedResult,
} from '../../../../api/functions/search-utils';

function makeBandcampResult(name: string, subdomain: string): PlatformResult {
  return {
    sourceId: 'bandcamp',
    name,
    type: 'artist',
    url: `https://${subdomain}.bandcamp.com`,
  };
}

function makeMirloResult(name: string, slug: string): PlatformResult {
  return {
    sourceId: 'mirlo',
    name,
    type: 'artist',
    url: `https://mirlo.space/${slug}`,
  };
}

describe('aggregateResults', () => {
  it('merges same-name Bandcamp + Mirlo into one result', () => {
    const results: PlatformResult[] = [
      makeBandcampResult('Kid Lightbulbs', 'kidlightbulbs'),
      makeMirloResult('Kid Lightbulbs', 'kidlightbulbs'),
    ];

    const aggregated = aggregateResults(results, 'kid lightbulbs');
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].platforms).toHaveLength(2);
    expect(aggregated[0].platforms.map(p => p.sourceId)).toContain('bandcamp');
    expect(aggregated[0].platforms.map(p => p.sourceId)).toContain('mirlo');
  });

  it('splits same-name artists on same platform with different URLs', () => {
    const results: PlatformResult[] = [
      makeBandcampResult('Matt Young', 'mattyoungmusictx'),
      makeBandcampResult('Matt Young', 'mattyoungmusic'),
    ];

    const aggregated = aggregateResults(results, 'matt young');
    expect(aggregated.length).toBeGreaterThanOrEqual(2);

    // Each should have exactly one Bandcamp platform
    const bandcampUrls = aggregated.map(
      r => r.platforms.find(p => p.sourceId === 'bandcamp')?.url
    );
    expect(bandcampUrls).toContain('https://mattyoungmusictx.bandcamp.com');
    expect(bandcampUrls).toContain('https://mattyoungmusic.bandcamp.com');
  });

  it('filters out search placeholder results', () => {
    const results: PlatformResult[] = [
      { sourceId: 'bandcamp', name: 'Search "test"', type: 'artist', url: 'https://test.bandcamp.com' },
      makeBandcampResult('Real Artist', 'realartist'),
    ];

    const aggregated = aggregateResults(results, 'test');
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].name).toBe('Real Artist');
  });

  it('sorts by text match score then platform count', () => {
    const results: PlatformResult[] = [
      makeBandcampResult('Not A Match', 'notamatch'),
      makeBandcampResult('Kid Lightbulbs', 'kidlightbulbs'),
      makeMirloResult('Kid Lightbulbs', 'kidlightbulbs'),
    ];

    const aggregated = aggregateResults(results, 'kid lightbulbs');
    expect(aggregated[0].name).toBe('Kid Lightbulbs');
  });

  it('preserves image URL from first result', () => {
    const results: PlatformResult[] = [
      { ...makeBandcampResult('Artist', 'artist'), imageUrl: 'https://img.com/photo.jpg' },
      makeMirloResult('Artist', 'artist'),
    ];

    const aggregated = aggregateResults(results, 'artist');
    expect(aggregated[0].imageUrl).toBe('https://img.com/photo.jpg');
  });
});

// ---------------------------------------------------------------------------
// mergeStoredArtistsIntoResults
// ---------------------------------------------------------------------------

describe('mergeStoredArtistsIntoResults', () => {
  const generic = (name: string): AggregatedResult => ({
    id: name.toLowerCase().replace(/\s/g, ''),
    name,
    type: 'artist',
    platforms: [{ sourceId: 'bandcamp', url: `https://${name.toLowerCase().replace(/\s/g, '')}.bandcamp.com` }],
    matchConfidence: 'verified',
  });

  const claimed = (name: string, slug: string): AggregatedResult => ({
    id: `claimed-${slug}`,
    name,
    type: 'artist',
    platforms: [{ sourceId: 'officialsite', url: `https://${slug}.example.com` }],
    matchConfidence: 'claimed',
    claimedSlug: slug,
  });

  it('replaces a generic same-name result in place, keeping its position', () => {
    // The "lightbulbs" bug: the platforms built a generic Kid Lightbulbs card
    // that ignored the artist's own claimed profile.
    const results = [generic('Lightbulb Factory'), generic('Kid Lightbulbs')];
    const merged = mergeStoredArtistsIntoResults(results, [claimed('Kid Lightbulbs', 'kid-lightbulbs')], 'lightbulbs');
    expect(merged).toHaveLength(2);
    expect(merged[1].matchConfidence).toBe('claimed');
    expect(merged[1].claimedSlug).toBe('kid-lightbulbs');
  });

  it('appends a claimed artist the platforms missed entirely', () => {
    // The "blood" bug: Cloud Blood has a claimed page but no platform hit.
    const results = [generic('Blood')];
    const merged = mergeStoredArtistsIntoResults(results, [claimed('Cloud Blood', 'cloud-blood')], 'blood');
    expect(merged.map(r => r.name)).toEqual(['Blood', 'Cloud Blood']);
    expect(merged[1].matchConfidence).toBe('claimed');
  });

  it('puts an exact query match first', () => {
    const results = [generic('Kid Lightbulbs Tribute'), generic('Kid Lightbulbs')];
    const merged = mergeStoredArtistsIntoResults(results, [claimed('Kid Lightbulbs', 'kid-lightbulbs')], 'kid lightbulbs');
    expect(merged[0].claimedSlug).toBe('kid-lightbulbs');
    expect(merged).toHaveLength(2);
  });

  it('replaces article-variant names too', () => {
    const results = [generic('Argent Grub')];
    const merged = mergeStoredArtistsIntoResults(results, [claimed('The Argent Grub', 'the-argent-grub')], 'argent');
    expect(merged).toHaveLength(1);
    expect(merged[0].matchConfidence).toBe('claimed');
  });

  it('dedupes when the exact and name-contains lookups find the same artist', () => {
    const kid = claimed('Kid Lightbulbs', 'kid-lightbulbs');
    const merged = mergeStoredArtistsIntoResults([], [kid, { ...kid }], 'kid lightbulbs');
    expect(merged).toHaveLength(1);
  });

  it('leaves unrelated results untouched', () => {
    const results = [generic('Radiohead')];
    const merged = mergeStoredArtistsIntoResults(results, [], 'radiohead');
    expect(merged).toEqual(results);
  });

  const known = (name: string, slug: string): AggregatedResult => ({
    id: `known-${slug}`,
    name,
    type: 'artist',
    platforms: [{ sourceId: 'bandcamp', url: `https://${slug.replace(/-/g, '')}.bandcamp.com` }],
    matchConfidence: 'verified',
    knownSlug: slug,
  });

  it('appends a known (previously-resolved) artist the platforms missed', () => {
    // The "patrick" bug: Patrick Hardy was persisted by past exact searches
    // but partial queries never consulted the artists table.
    const results = [generic('Patrick')];
    const merged = mergeStoredArtistsIntoResults(results, [known('Patrick Hardy', 'patrick-hardy')], 'patrick');
    expect(merged.map(r => r.name)).toEqual(['Patrick', 'Patrick Hardy']);
  });

  it('attaches a known slug to a live result without displacing it', () => {
    // The live pipeline just verified this result and wins on identity/freshness,
    // but its pre-generated /artist/ page slug is still worth surfacing.
    const live = generic('Patrick Hardy');
    const merged = mergeStoredArtistsIntoResults([live], [known('Patrick Hardy', 'patrick-hardy')], 'patrick');
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(live.id);
    expect(merged[0].knownSlug).toBe('patrick-hardy');
  });

  it('attaches a known slug through article-insensitive name matching too', () => {
    const live = generic('Argent Grub');
    const merged = mergeStoredArtistsIntoResults([live], [known('The Argent Grub', 'the-argent-grub')], 'argent');
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(live.id);
    expect(merged[0].knownSlug).toBe('the-argent-grub');
  });
});
