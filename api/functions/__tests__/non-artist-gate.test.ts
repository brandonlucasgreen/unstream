// The gate that keeps non-musical entities out of the `artists` table.
//
// `/artist/chatgpt` existed because one search was enough to mint it: MusicBrainz holds a
// "ChatGPT" artist whose official site is chatgpt.com, and `splitSuspiciousPlatforms` defaults to
// `verified`, so the row landed in "Artists You Know". Deleting it does not hold on its own — the
// next search recreates it — which is why `persistSearchResults` has to refuse the write.
//
// The second half of this file is the part that matters most: the denylist must NOT catch real
// independent artists who happen to share a name with a company. `american-express`,
// `masterclass`, `nowplaying` and `seoulmetro` are all live Bandcamp pages with real releases.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isNonArtistSlug, NON_ARTIST_SLUGS } from '../../lib/non-artist-names';
import { artistSlug } from '../db';

describe('isNonArtistSlug', () => {
  it.each([
    ['ChatGPT', 'the OpenAI product'],
    ['Saturday Night Live', 'the NBC show'],
    ['LANDR', 'the mastering SaaS'],
    ['Coca-Cola', 'the beverage brand'],
  ])('rejects "%s" (%s)', name => {
    expect(isNonArtistSlug(artistSlug(name))).toBe(true);
  });

  it('matches however a source punctuates the name', () => {
    // The stored row spelled it with U+2010 HYPHEN, not an ASCII dash, and MusicBrainz shouts
    // some names. Keying on artistSlug() output is what makes both land on the same entry.
    expect(isNonArtistSlug(artistSlug('Coca‐Cola'))).toBe(true);
    expect(isNonArtistSlug(artistSlug('coca cola'))).toBe(true);
    expect(isNonArtistSlug(artistSlug('chatgpt'))).toBe(true);
    expect(isNonArtistSlug(artistSlug('ChatGPT '))).toBe(true);
  });

  it.each([
    'American Express',
    'masterclass',
    'Now Playing',
    'Seoul Metro',
    'Claude',
    'control.org',
    'CANVA',
  ])('keeps "%s" — a real Bandcamp artist that collides with a brand name', name => {
    expect(isNonArtistSlug(artistSlug(name))).toBe(false);
  });

  it('holds only slugs, so a stray display name cannot silently never match', () => {
    for (const slug of NON_ARTIST_SLUGS) {
      expect(slug).toBe(artistSlug(slug));
    }
  });
});

describe('persistSearchResults refuses denylisted names', () => {
  const upsert = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    upsert.mockReset();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';

    // `upsert` is recorded with its table name: persisting one artist also bulk-upserts
    // artist_links, so a bare call count would not distinguish "no artist row" from
    // "no writes at all".
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: (table: string) => ({
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }),
            in: () => ({ or: () => Promise.resolve({ data: [], error: null }) }),
          }),
          upsert: (payload: unknown) => {
            upsert(table, payload);
            return {
              select: () => ({ single: () => Promise.resolve({ data: { id: 'id' }, error: null }) }),
            };
          },
        }),
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock('@supabase/supabase-js');
  });

  const result = (name: string) => ({
    id: `search-${name}`,
    name,
    type: 'artist' as const,
    matchConfidence: 'verified' as const,
    platforms: [{ sourceId: 'bandcamp', url: 'https://example.bandcamp.com' }],
  });

  const artistUpserts = () => upsert.mock.calls.filter(([table]) => table === 'artists');

  it('writes no artist row for a denylisted name', async () => {
    const { persistSearchResults } = await import('../db');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistSearchResults([result('ChatGPT')] as any);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('still writes a row for an ordinary artist, so the gate is not blocking everything', async () => {
    const { persistSearchResults } = await import('../db');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistSearchResults([result('Melondruie')] as any);
    expect(artistUpserts()).toHaveLength(1);
    expect(artistUpserts()[0][1]).toMatchObject({ slug: 'melondruie', name: 'Melondruie' });
  });

  it('drops only the denylisted name out of a mixed batch', async () => {
    const { persistSearchResults } = await import('../db');
    await persistSearchResults([
      result('ChatGPT'),
      result('Melondruie'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    expect(artistUpserts().map(([, payload]) => (payload as { slug: string }).slug)).toEqual([
      'melondruie',
    ]);
  });
});
