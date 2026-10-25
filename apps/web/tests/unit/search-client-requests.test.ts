import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchPlatforms, fetchStoredArtists, fetchMusicBrainzData, SearchRequestError } from '../../src/services/sources';

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

// A failed search must not look like an empty one (audit 2026-10-25 #2).
describe('searchPlatforms failures', () => {
  it('throws with the status on a 429 instead of returning no results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(searchPlatforms('Radiohead')).rejects.toMatchObject({ name: 'SearchRequestError', status: 429 });
  });

  it('throws without a status on a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await searchPlatforms('Radiohead').catch(e => e);
    expect(error).toBeInstanceOf(SearchRequestError);
    expect(error.status).toBeUndefined();
  });

  it('marks a multi-artist search partial when only some parts answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const q = new URL(String(input), 'https://unstream.stream').searchParams.get('query');
      return q === 'ilyBBY'
        ? new Response('{}', { status: 500 })
        : okJson({ query: q, results: [] });
    });
    const response = await searchPlatforms('Kid Lightbulbs feat. ilyBBY');
    expect(response.partial).toBe(true);
  });

  it('throws when every part of a multi-artist search fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(searchPlatforms('Kid Lightbulbs feat. ilyBBY')).rejects.toBeInstanceOf(SearchRequestError);
  });
});

describe('fetchMusicBrainzData', () => {
  it('throws on a failed request rather than looking like "not known"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(fetchMusicBrainzData('Radiohead')).rejects.toBeInstanceOf(SearchRequestError);
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
