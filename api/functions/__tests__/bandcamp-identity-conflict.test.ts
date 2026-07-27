import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The bug this guards, reported by the artist Honeycrush:
//
//   /?q=honeycrush returned one result named "Honey Crush" whose Bandcamp button
//   opened a Bandcamp *signup form*, mixed with the real Honeycrush's location,
//   Instagram and Patreon.
//
// Three independent faults stacked up:
//
//   1. MusicBrainz lists https://honeyyycrush.bandcamp.com/ for the real artist. That
//      subdomain was retired and now answers 303 -> bandcamp.com/signup?new_domain=…,
//      but nothing ever fetched it, so the dead link shipped.
//   2. The subdomain probe derived slug "honeycrush", which is a real and unrelated
//      Orlando band literally named "Honey Crush". Name match and release count both
//      pass — neither check can see it is someone else.
//   3. MB's (dead) URL then overwrote the probe's (live) one, and MB's enrichment was
//      grafted onto the homonym, producing one result assembled from two artists.

import {
  bandcampSubdomainOf,
  bandcampSubdomainConflicts,
  isBandcampSearchLink,
} from '../search-utils';

describe('bandcampSubdomainOf', () => {
  it('extracts the subdomain from an artist URL', () => {
    expect(bandcampSubdomainOf('https://honeycrushing.bandcamp.com/')).toBe('honeycrushing');
    expect(bandcampSubdomainOf('https://honeyyycrush.bandcamp.com/music')).toBe('honeyyycrush');
  });

  it('lowercases so a casing difference is not read as a different account', () => {
    expect(bandcampSubdomainOf('https://HoneyCrushing.bandcamp.com/')).toBe('honeycrushing');
  });

  it('returns null for non-Bandcamp and malformed URLs', () => {
    expect(bandcampSubdomainOf('https://honeycrushing.com/')).toBeNull();
    expect(bandcampSubdomainOf('https://bandcamp.com/search?q=honeycrush')).toBeNull();
    expect(bandcampSubdomainOf('not a url')).toBeNull();
    expect(bandcampSubdomainOf(null)).toBeNull();
  });
});

describe('bandcampSubdomainConflicts', () => {
  it('flags the Honeycrush case: MB names one account, the probe matched another', () => {
    expect(
      bandcampSubdomainConflicts('honeyyycrush', 'https://honeycrush.bandcamp.com/')
    ).toBe(true);
  });

  it('does not flag the same account', () => {
    expect(
      bandcampSubdomainConflicts('honeycrushing', 'https://honeycrushing.bandcamp.com/')
    ).toBe(false);
  });

  it('treats a missing side as absence, not conflict', () => {
    // MB has no Bandcamp relation — the probe's find is all we have, and it stands.
    expect(bandcampSubdomainConflicts(null, 'https://honeycrush.bandcamp.com/')).toBe(false);
    // The probe found nothing — a search-link placeholder must not read as a rival account.
    expect(bandcampSubdomainConflicts('honeyyycrush', undefined)).toBe(false);
    expect(
      bandcampSubdomainConflicts('honeyyycrush', 'https://bandcamp.com/search?q=honeycrush')
    ).toBe(false);
  });

  it('ignores custom domains rather than guessing they are a different account', () => {
    expect(bandcampSubdomainConflicts('honeyyycrush', 'https://honeycrushing.com/')).toBe(false);
  });
});

describe('isBandcampSearchLink', () => {
  it('recognises the placeholder that MB data is allowed to replace', () => {
    expect(isBandcampSearchLink('https://bandcamp.com/search?q=honeycrush')).toBe(true);
  });

  it('does not treat a real artist page as replaceable', () => {
    expect(isBandcampSearchLink('https://honeycrushing.bandcamp.com/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkBandcampSubdomain — the retired-account check
// ---------------------------------------------------------------------------

// Redis is not available in tests; cacheGetOrFetch falls through to the fetch fn.
vi.mock('../cache', () => ({
  cacheGetOrFetch: async (_key: string, fetchFn: () => Promise<unknown>) => ({
    data: await fetchFn(),
    cached: false,
  }),
}));

const { checkBandcampSubdomain } = await import('../../search/enrichment');

function response(status: number, location?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location ?? null : null) },
  } as unknown as Response;
}

describe('checkBandcampSubdomain', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls a retired subdomain dead', async () => {
    // The exact response honeyyycrush.bandcamp.com gives today.
    vi.mocked(globalThis.fetch).mockResolvedValue(
      response(303, 'https://bandcamp.com/signup?new_domain=honeyyycrush')
    );
    await expect(checkBandcampSubdomain('https://honeyyycrush.bandcamp.com/')).resolves.toBe('dead');
  });

  it('calls a live subdomain live', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(response(200));
    await expect(checkBandcampSubdomain('https://honeycrushing.bandcamp.com/')).resolves.toBe('live');
  });

  it('does not call an unrelated redirect dead', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      response(301, 'https://honeycrushing.bandcamp.com/music')
    );
    await expect(checkBandcampSubdomain('https://honeycrushing.bandcamp.com/')).resolves.toBe('live');
  });

  it('reports unknown when the check fails, never dead', async () => {
    // The whole point of the tri-state: an outage must not strip good links off results.
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network down'));
    await expect(checkBandcampSubdomain('https://honeycrushing.bandcamp.com/')).resolves.toBe('unknown');

    vi.mocked(globalThis.fetch).mockResolvedValue(response(429));
    await expect(checkBandcampSubdomain('https://honeycrushing.bandcamp.com/')).resolves.toBe('unknown');
  });

  it('refuses a host outside the SSRF allowlist without fetching', async () => {
    await expect(checkBandcampSubdomain('https://evil.example.com/')).resolves.toBe('unknown');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('uses HEAD and does not follow the redirect', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(response(200));
    await checkBandcampSubdomain('https://honeycrushing.bandcamp.com/');
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(init).toMatchObject({ method: 'HEAD', redirect: 'manual' });
  });
});
