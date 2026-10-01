// Which card a bio lands on. A bio is far more visible than a link, so a stranger's biography
// under the wrong name is the failure worth locking out.

import { describe, it, expect } from 'vitest';
import { attachBios, mergeStoredArtistsIntoResults, type AggregatedResult, type MbBioInput } from '../search-utils';

function card(overrides: Partial<AggregatedResult> = {}): AggregatedResult {
  return { id: 'r1', name: 'Kid Lightbulbs', type: 'artist', platforms: [], matchConfidence: 'verified', ...overrides };
}

const MB: MbBioInput = {
  resultId: 'r1',
  discogsUrl: 'https://www.discogs.com/artist/1',
  officialUrl: null,
  discogsProfile: 'Experimental rock project from [a=Brooklyn Collective].',
  wikipediaSummary: 'Kid Lightbulbs is an American rock band.',
  wikipediaUrl: 'https://en.wikipedia.org/wiki/Kid_Lightbulbs',
};

describe('attachBios', () => {
  it("prefers the artist's own Bandcamp bio, attached by their own subdomain", () => {
    const results = [card({ platforms: [{ sourceId: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com' }] })];
    attachBios(results, new Map([['kidlightbulbs', 'Songs about light and noise.']]), MB);
    expect(results[0].bio).toMatchObject({ source: 'bandcamp', sourceUrl: 'https://kidlightbulbs.bandcamp.com' });
  });

  it('does not put one Bandcamp account\'s bio on a card for a different account', () => {
    const results = [card({ id: 'other', platforms: [{ sourceId: 'bandcamp', url: 'https://someoneelse.bandcamp.com' }] })];
    attachBios(results, new Map([['kidlightbulbs', 'Songs about light and noise.']]), null);
    expect(results[0].bio).toBeUndefined();
  });

  const discogsLink = { sourceId: 'discogs' as const, url: 'https://www.discogs.com/artist/1' };

  it('falls back to Discogs, then Wikipedia, only on the card MusicBrainz enriched', () => {
    const enriched = card({ platforms: [discogsLink] });
    const homonym = card({ id: 'r2' });
    attachBios([enriched, homonym], new Map(), MB);
    expect(enriched.bio?.source).toBe('discogs');
    expect(homonym.bio).toBeUndefined();

    const noDiscogs = card({ platforms: [discogsLink] });
    attachBios([noDiscogs], new Map(), { ...MB, discogsProfile: null });
    expect(noDiscogs.bio?.source).toBe('wikipedia');
  });

  it('drops the Discogs bio when an admin suppressed the Discogs link', () => {
    const suppressed = card();
    attachBios([suppressed], new Map(), MB);
    expect(suppressed.bio?.source).toBe('wikipedia');
  });

  it('finds the enriched card by its Discogs link when a merge changed its id', () => {
    const merged = card({ id: 'merged', platforms: [{ sourceId: 'discogs', url: 'https://www.discogs.com/artist/1' }] });
    attachBios([merged], new Map(), MB);
    expect(merged.bio?.source).toBe('discogs');
  });
});

describe('mergeStoredArtistsIntoResults and bios', () => {
  const liveBio = { text: 'Found on Bandcamp.', source: 'bandcamp' as const, sourceUrl: 'https://x.bandcamp.com', truncated: false };

  it('lets a claimed card with no bio of its own inherit the live one', () => {
    const merged = mergeStoredArtistsIntoResults(
      [card({ bio: liveBio })],
      [card({ id: 'claimed-kid', matchConfidence: 'claimed' })],
      'Kid Lightbulbs',
    );
    expect(merged[0].bio).toEqual(liveBio);
  });

  it('never gives a live bio to an artist who turned bios off', () => {
    const merged = mergeStoredArtistsIntoResults(
      [card({ bio: liveBio })],
      [card({ id: 'claimed-kid', matchConfidence: 'claimed', bioSuppressed: true })],
      'Kid Lightbulbs',
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].bio).toBeUndefined();
    expect(merged[0].bioSuppressed).toBe(true);
  });
});
