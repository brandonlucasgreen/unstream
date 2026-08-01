// The admin catalog endpoint.
//
// What's worth locking here is entirely about not reporting a confident wrong thing. This
// endpoint exists to make cataloging observable, so the failure that matters isn't a crash —
// it's answering "never catalogued" when the truth is "we couldn't ask", or "queued" when the
// deploy can't run a crawl at all.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCatalogState: vi.fn(),
  clearCatalogCooldown: vi.fn(),
  authenticateAdmin: vi.fn(),
  fetch: vi.fn(() => Promise.resolve({ status: 202, ok: false } as Response)),
}));

// getCatalogState/clearCatalogCooldown are the real db.ts functions, shared with the
// artist-facing endpoint. The shape of the cooldown patch is covered where it lives; what this
// file asserts is that the endpoint *asks for* the clear before queuing — without which the
// button appears to work and silently does nothing for a week.
vi.mock('../db', () => ({
  getCatalogState: mocks.getCatalogState,
  clearCatalogCooldown: mocks.clearCatalogCooldown,
}));

vi.mock('../middleware', () => ({
  authenticateAdmin: mocks.authenticateAdmin,
  buildCorsHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

const { handler } = await import('../admin-catalog-artist');

const ARTIST = '11111111-2222-3333-4444-555555555555';
const headers = { authorization: 'Bearer admin-token' };

function get(artistId = ARTIST) {
  return handler({ httpMethod: 'GET', headers, queryStringParameters: { artistId } });
}
function post(artistId = ARTIST) {
  return handler({ httpMethod: 'POST', headers, body: JSON.stringify({ artistId }) });
}

beforeEach(() => {
  mocks.authenticateAdmin.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' });
  mocks.getCatalogState.mockResolvedValue({ ok: true, state: null });
  mocks.clearCatalogCooldown.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', mocks.fetch);
  process.env.RELEASE_CATALOG_ENABLED = 'true';
  process.env.INTERNAL_FUNCTION_SECRET = 'secret';
  process.env.URL = 'https://unstream.stream';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.RELEASE_CATALOG_ENABLED;
  delete process.env.INTERNAL_FUNCTION_SECRET;
  delete process.env.URL;
});

describe('auth', () => {
  it('refuses anyone who is not an admin, including anonymous callers', async () => {
    mocks.authenticateAdmin.mockResolvedValue(null);
    expect((await get()).statusCode).toBe(403);
    expect((await post()).statusCode).toBe(403);
  });

  it('rejects an artistId that is not a UUID', async () => {
    expect((await get('../../etc/passwd')).statusCode).toBe(400);
  });
});

describe('GET — reading the state', () => {
  it('reports a genuinely never-catalogued artist as a null state, not an error', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ admin: true, state: null });
  });

  // The bug this exists to prevent: a failed read and "never catalogued" both arriving as null
  // makes a broken database render as a confident fact about the artist.
  it('does not report a failed read as a null state', async () => {
    mocks.getCatalogState.mockResolvedValue({ ok: false, reason: 'Could not read catalog state' });
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toBeTruthy();
    expect(JSON.parse(response.body).state).toBeUndefined();
  });

  it('passes a real state through', async () => {
    mocks.getCatalogState.mockResolvedValue({
      ok: true,
      state: { last_catalogued_at: '2026-07-31T00:00:00Z', releases_found: 16, releases_detailed: 16, last_error: null, consecutive_failures: 0 },
    });
    const body = JSON.parse((await get()).body);
    expect(body.state.releases_found).toBe(16);
  });
});

describe('POST — starting a crawl', () => {
  it('queues the crawl and clears the cooldown first', async () => {
    const response = await post();
    expect(response.statusCode).toBe(202);
    // Without this the button appears to work and silently does nothing for a week.
    expect(mocks.clearCatalogCooldown).toHaveBeenCalledWith(ARTIST);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  // Netlify answers 202 to a background invocation the instant it is queued and discards the
  // handler's response — so any refusal we can predict has to be caught here, or it reaches the
  // UI as a crawl that simply never finishes.
  it('refuses where cataloging is disabled rather than queuing a crawl that will be rejected', async () => {
    delete process.env.RELEASE_CATALOG_ENABLED;
    const response = await post();
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toContain('RELEASE_CATALOG_ENABLED');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses when the internal secret is missing', async () => {
    delete process.env.INTERNAL_FUNCTION_SECRET;
    const response = await post();
    expect(response.statusCode).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  // A boolean derived from that 202 would read as "the crawl was accepted" while being true
  // even when it wasn't, so there deliberately isn't one.
  it('does not claim the background function accepted the job', async () => {
    const body = JSON.parse((await post()).body);
    expect(body.started).toBeUndefined();
  });
});
