import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchPlatforms, fetchStoredArtists } from '../../src/services/sources';

// What the search box asks the server for.
//
// - A single-artist search sends `enrichment=deferred`: App.tsx runs Phase 2 itself when
//   hasPendingEnrichment comes back, so the server need not wait on MusicBrainz.
// - A multi-artist search must NOT: its merged response carries no hasPendingEnrichment, so
//   Phase 2 never runs for the individual artists and the server has to enrich them inline.
// - The stored-artists preview never breaks a search: any failure is just no early cards.

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function requestedUrls(fetchSpy: ReturnType<typeof vi.spyOn>): URL[] {
  return fetchSpy.mock.calls.map(c => new URL(String(c[0]), 'https://unstream.stream'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchPlatforms', () => {
  it('defers MusicBrainz for a single-artist search', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ query: 'Radiohead', results: [] }));

    await searchPlatforms('Radiohead');

    const [url] = requestedUrls(fetchSpy);
    expect(url.pathname).toBe('/api/search/sources');
    expect(url.searchParams.get('enrichment')).toBe('deferred');
  });

  it('does not defer MusicBrainz for any part of a multi-artist search', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okJson({ query: 'x', results: [] }));

    await searchPlatforms('Kid Lightbulbs feat. ilyBBY');

    const urls = requestedUrls(fetchSpy);
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) expect(url.searchParams.has('enrichment')).toBe(false);
  });
});

describe('fetchStoredArtists', () => {
  it('returns the stored cards', async () => {
    const card = { id: 'claimed-kid-lightbulbs', name: 'Kid Lightbulbs', type: 'artist', platforms: [] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ query: 'Kid Lightbulbs', results: [card] }));

    expect(await fetchStoredArtists('Kid Lightbulbs')).toEqual([card]);
  });

  it('returns nothing when the server errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }));
    expect(await fetchStoredArtists('Kid Lightbulbs')).toEqual([]);
  });

  it('returns nothing when the network fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await fetchStoredArtists('Kid Lightbulbs')).toEqual([]);
  });
});
