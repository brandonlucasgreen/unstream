import { describe, it, expect, vi, beforeEach } from 'vitest';

// The claim flow end to end against an in-memory database. The case this pins: a link-back on a
// website we don't already hold for the artist must not verify the claim or touch their links;
// it files a manual-review request instead. Before, any page naming the artist and linking
// back verified instantly and replaced the artist's Bandcamp/Patreon/Ko-fi links.

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  safeFetch: vi.fn(),
  sendNotificationOnce: vi.fn(),
  notifySavedArtistsOfNewLinks: vi.fn(() => Promise.resolve()),
  user: { id: 'user-1', email: 'claimant@example.com' },
}));

/** Just enough of the PostgREST query builder for claim-artist.ts. */
function fakeClient() {
  return {
    from(table: string) {
      const rows = (mocks.tables[table] ??= []);
      const filters: [string, unknown][] = [];
      let op: 'select' | 'update' | 'insert' | 'upsert' = 'select';
      let payload: Row = {};
      let conflictKeys: string[] = [];
      const matching = () => rows.filter(r => filters.every(([k, v]) => r[k] === v));
      const run = () => {
        if (op === 'insert') {
          rows.push({ id: `id-${rows.length + 1}`, ...payload });
        } else if (op === 'update') {
          for (const r of matching()) Object.assign(r, payload);
        } else if (op === 'upsert') {
          const existing = rows.find(r => conflictKeys.every(k => r[k] === payload[k]));
          if (existing) Object.assign(existing, payload);
          else rows.push({ id: `id-${rows.length + 1}`, ...payload });
        }
        return { data: op === 'select' ? matching() : null, error: null };
      };
      const builder = {
        select: () => builder,
        eq: (k: string, v: unknown) => (filters.push([k, v]), builder),
        update: (p: Row) => ((op = 'update'), (payload = p), builder),
        insert: (p: Row) => ((op = 'insert'), (payload = p), Promise.resolve(run())),
        upsert: (p: Row, opts?: { onConflict?: string }) => {
          op = 'upsert';
          payload = p;
          conflictKeys = (opts?.onConflict ?? 'id').split(',');
          return Promise.resolve(run());
        },
        single: () => {
          const found = matching();
          return Promise.resolve({ data: found[0] ?? null, error: found[0] ? null : { code: 'PGRST116' } });
        },
        maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      };
      return builder;
    },
  };
}

vi.mock('../db', () => ({ getClient: () => fakeClient() }));
vi.mock('../safe-fetch', () => ({ safeFetch: mocks.safeFetch }));
vi.mock('../ratelimit', () => ({
  checkRateLimit: () => Promise.resolve({ limited: false }),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../notifications', () => ({
  sendNotificationOnce: mocks.sendNotificationOnce,
  notifySavedArtistsOfNewLinks: mocks.notifySavedArtistsOfNewLinks,
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: mocks.user }, error: null }) },
  }),
}));

import { handler } from '../claim-artist';

const ARTIST = { id: 'artist-1', name: 'Kid Lightbulbs', slug: 'kid-lightbulbs', image_url: null };

function post(body: Row) {
  return handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

/** A page naming the artist, linking back, and offering a Bandcamp link. */
function sitePage(bandcampUrl: string) {
  return new Response(
    `<html><title>Kid Lightbulbs</title><body>
      <a href="https://unstream.stream/a/kid-lightbulbs">Unstream</a>
      <a href="${bandcampUrl}">Bandcamp</a>
    </body></html>`,
    { status: 200 }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  mocks.user = { id: 'user-1', email: 'claimant@example.com' };
  mocks.tables = {
    artists: [{ ...ARTIST }],
    artist_links: [
      { artist_id: ARTIST.id, platform: 'officialsite', url: 'https://kidlightbulbs.com/', source: 'auto' },
      { artist_id: ARTIST.id, platform: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com/', source: 'auto' },
    ],
    artist_profiles: [],
    verification_requests: [],
  };
});

describe('claim-artist verify', () => {
  it('verifies instantly on the official site we already hold', async () => {
    mocks.safeFetch.mockResolvedValue(sitePage('https://kidlightbulbs.bandcamp.com/'));
    await post({ action: 'start', slug: ARTIST.slug, websiteUrl: 'https://www.kidlightbulbs.com/' });

    const res = await post({ action: 'verify', slug: ARTIST.slug });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).verified).toBe(true);
    expect(mocks.tables.artist_profiles[0].verified_at).toBeTruthy();
    expect(mocks.tables.verification_requests).toHaveLength(0);
  });

  it('queues a site we hold nothing for, leaving the profile and links untouched', async () => {
    mocks.safeFetch.mockResolvedValue(sitePage('https://impostor.bandcamp.com/'));
    await post({ action: 'start', slug: ARTIST.slug, websiteUrl: 'https://kid-lightbulbs.pages.dev/' });

    const res = await post({ action: 'verify', slug: ARTIST.slug });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.verified).toBe(false);
    expect(body.pendingReview).toBe(true);
    expect(mocks.tables.artist_profiles[0].verified_at).toBeNull();
    expect(mocks.tables.artist_links.find(l => l.platform === 'bandcamp')?.url).toBe(
      'https://kidlightbulbs.bandcamp.com/'
    );
    expect(mocks.tables.verification_requests).toHaveLength(1);
    expect(mocks.tables.verification_requests[0]).toMatchObject({
      artist_id: ARTIST.id,
      user_id: 'user-1',
      status: 'pending',
    });
    expect(mocks.sendNotificationOnce).not.toHaveBeenCalled();
    expect(mocks.notifySavedArtistsOfNewLinks).not.toHaveBeenCalled();
  });

  it('files one review request however many times verify is pressed', async () => {
    mocks.safeFetch.mockImplementation(async () => sitePage('https://impostor.bandcamp.com/'));
    await post({ action: 'start', slug: ARTIST.slug, websiteUrl: 'https://kid-lightbulbs.pages.dev/' });

    await post({ action: 'verify', slug: ARTIST.slug });
    await post({ action: 'verify', slug: ARTIST.slug });

    expect(mocks.tables.verification_requests).toHaveLength(1);
  });
});

describe('claim-artist start', () => {
  it("won't overwrite someone else's recent claim in progress", async () => {
    mocks.tables.artist_profiles.push({
      id: 'p-1',
      artist_id: ARTIST.id,
      user_id: 'someone-else',
      verified_at: null,
      updated_at: new Date().toISOString(),
    });

    const res = await post({ action: 'start', slug: ARTIST.slug, websiteUrl: 'https://kidlightbulbs.com/' });

    expect(res.statusCode).toBe(409);
    expect(mocks.tables.artist_profiles[0].user_id).toBe('someone-else');
  });

  it('takes over a claim abandoned for more than a week', async () => {
    mocks.tables.artist_profiles.push({
      id: 'p-1',
      artist_id: ARTIST.id,
      user_id: 'someone-else',
      verified_at: null,
      updated_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const res = await post({ action: 'start', slug: ARTIST.slug, websiteUrl: 'https://kidlightbulbs.com/' });

    expect(res.statusCode).toBe(200);
    expect(mocks.tables.artist_profiles[0].user_id).toBe('user-1');
  });

  it("stores the signed-in account's email, not one from the request body", async () => {
    await post({
      action: 'start',
      slug: ARTIST.slug,
      websiteUrl: 'https://kidlightbulbs.com/',
      email: 'victim@example.com',
    });

    expect(mocks.tables.artist_profiles[0].email).toBe('claimant@example.com');
  });
});
