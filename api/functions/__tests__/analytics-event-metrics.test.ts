// The two metrics added for the artist Analytics page (2026-11-08): `streaming`, a search
// appearance that came from a fan listening on a streaming service, and
// `release_view:<release id>`, a view of one release page. A release view has to name one of the
// artist's own releases — otherwise anyone could write rows the artist's page would go looking up.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const ARTIST_ID = 'artist-1';
const OWN_RELEASE = '11111111-1111-4111-8111-111111111111';
const OTHER_RELEASE = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), releaseLookups: 0 }));

vi.mock('../db', () => ({
  getClient: () => ({
    from: (table: string) => ({
      select: () => {
        if (table === 'artists') {
          return { in: (_c: string, slugs: string[]) => Promise.resolve({ data: slugs.map(slug => ({ id: ARTIST_ID, slug })), error: null }) };
        }
        // releases: .eq('id', …).eq('artist_id', …).maybeSingle()
        const filters: Record<string, string> = {};
        const chain = {
          eq: (column: string, value: string) => { filters[column] = value; return chain; },
          maybeSingle: () => {
            mocks.releaseLookups += 1;
            const owned = filters.id === OWN_RELEASE && filters.artist_id === ARTIST_ID;
            return Promise.resolve({ data: owned ? { id: OWN_RELEASE } : null, error: null });
          },
        };
        return chain;
      },
    }),
    rpc: mocks.rpc,
  }),
}));
vi.mock('../ratelimit', () => ({
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '203.0.113.7',
}));

import { handler } from '../analytics-event';

const post = (body: unknown) => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: null, error: null });
});

describe('analytics-event metrics for the Analytics page', () => {
  it('records a streaming appearance', async () => {
    await post({ slug: 'streamed-artist', metric: 'streaming' });
    expect(mocks.rpc).toHaveBeenCalledWith('increment_analytics', expect.objectContaining({ p_metric: 'streaming' }));
  });

  it("records a view of the artist's own release, and remembers the check", async () => {
    const before = mocks.releaseLookups;
    await post({ slug: 'release-artist', metric: `release_view:${OWN_RELEASE}` });
    await post({ slug: 'release-artist', metric: `release_view:${OWN_RELEASE}` });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledWith('increment_analytics', expect.objectContaining({ p_metric: `release_view:${OWN_RELEASE}` }));
    expect(mocks.releaseLookups - before).toBe(1);
  });

  it("drops a view naming someone else's release", async () => {
    await post({ slug: 'release-artist', metric: `release_view:${OTHER_RELEASE}` });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('drops a release view whose id is not an id', async () => {
    await post({ slug: 'release-artist', metric: 'release_view:../../etc' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('drops a release view sent for several artists at once', async () => {
    await post({ slugs: ['a', 'b'], metric: `release_view:${OWN_RELEASE}` });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
