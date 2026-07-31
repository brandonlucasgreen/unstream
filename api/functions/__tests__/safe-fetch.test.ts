// Direct tests for the shared safe-fetch module.
//
// check-releases-ssrf.test.ts already exercises this heavily *through* the handler; these
// pin the exported surface itself, because it is now shared and the next caller (release
// catalog ingest) won't go through that handler. The properties worth locking are the two
// that are easy to reimplement wrongly: every hop gets re-validated, and refusal is the
// default whenever a check can't be completed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn() }));
vi.mock('dns/promises', () => ({ lookup: mocks.lookup }));

import { safeFetch, safeHostname, resolvesToPublicAddress, MAX_REDIRECTS, FETCH_USER_AGENT } from '../safe-fetch';

function res(status: number, opts: { location?: string; url?: string } = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: opts.url ?? '',
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? opts.location ?? null : null) },
    text: async () => '',
  } as unknown as Response;
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue(PUBLIC);
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('safeHostname', () => {
  it('extracts the hostname', () => {
    expect(safeHostname('https://example.com/a/b?c=d')).toBe('example.com');
  });

  it('returns a sentinel rather than throwing on junk', () => {
    expect(safeHostname('not a url')).toBe('<unparseable>');
    expect(safeHostname('')).toBe('<unparseable>');
  });
});

describe('resolvesToPublicAddress', () => {
  it('accepts a host whose every answer is public', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
    expect(await resolvesToPublicAddress('example.com')).toBe(true);
  });

  it('rejects a host resolving into private space', async () => {
    mocks.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    expect(await resolvesToPublicAddress('169-254-169-254.nip.io')).toBe(false);
  });

  it('rejects when any single answer is private', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: 'fd00::1', family: 6 },
    ]);
    expect(await resolvesToPublicAddress('dual-stack.example.com')).toBe(false);
  });

  it('refuses on resolver failure, empty answers, or a junk hostname', async () => {
    mocks.lookup.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await resolvesToPublicAddress('nope.example.com')).toBe(false);

    mocks.lookup.mockResolvedValue([]);
    expect(await resolvesToPublicAddress('empty.example.com')).toBe(false);

    expect(await resolvesToPublicAddress('<unparseable>')).toBe(false);
    expect(await resolvesToPublicAddress('')).toBe(false);
  });
});

describe('safeFetch', () => {
  it('fetches a public host with manual redirects and a UA', async () => {
    mocks.fetch.mockResolvedValue(res(200));

    const r = await safeFetch('https://example.com/x');

    expect(r?.status).toBe(200);
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({
      redirect: 'manual',
      headers: { 'User-Agent': FETCH_USER_AGENT },
    });
  });

  it('follows a redirect and re-resolves the new host', async () => {
    mocks.fetch
      .mockResolvedValueOnce(res(301, { location: 'https://elsewhere.example.com/y' }))
      .mockResolvedValue(res(200));

    await safeFetch('https://example.com/x');

    expect(mocks.lookup.mock.calls.map(c => c[0])).toEqual(['example.com', 'elsewhere.example.com']);
    expect(String(mocks.fetch.mock.calls[1][0])).toBe('https://elsewhere.example.com/y');
  });

  it('refuses a redirect into private space without fetching it', async () => {
    mocks.lookup.mockImplementation(async (h: string) =>
      h === 'example.com' ? PUBLIC : [{ address: '169.254.169.254', family: 4 }]
    );
    mocks.fetch.mockResolvedValueOnce(res(302, { location: 'https://evil.example.com/' }));

    expect(await safeFetch('https://example.com/x')).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an unsafe target outright, before any DNS or fetch', async () => {
    expect(await safeFetch('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(await safeFetch('file:///etc/passwd')).toBeNull();
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('bounds a redirect loop at MAX_REDIRECTS + 1 attempts', async () => {
    mocks.fetch.mockResolvedValue(res(302, { location: 'https://example.com/loop' }));

    expect(await safeFetch('https://example.com/loop')).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('returns a 3xx with no Location as-is, so callers fail closed on .ok', async () => {
    mocks.fetch.mockResolvedValue(res(302));

    const r = await safeFetch('https://example.com/x');

    expect(r?.status).toBe(302);
    expect(r?.ok).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative Location against the current URL', async () => {
    mocks.fetch
      .mockResolvedValueOnce(res(301, { location: '/moved' }))
      .mockResolvedValue(res(200));

    await safeFetch('https://example.com/deep/path');

    expect(String(mocks.fetch.mock.calls[1][0])).toBe('https://example.com/moved');
  });
});
