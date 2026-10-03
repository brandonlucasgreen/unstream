// Replacing a stored artist photo that its host has deleted, during the Bandcamp catalogue pass.
//
// Measured 2026-10-02: 12 of the 139 verified artists' stored photos 404'd, all on Bandcamp,
// because search never writes to a claimed artist's row. These tests pin when the pass may
// replace one (only on the host's own 404 or 410, only with a photo from the artist's own page,
// never over a photo the artist chose) and that a host that didn't answer changes nothing.
//
// The parsers, the allowlist and the name match are real. Only the network and the database are
// stubbed, and the last block drives the real catalogue handler to prove the pass calls it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimArtistForCatalog: vi.fn(),
  getArtistForCatalog: vi.fn(),
  persistReleases: vi.fn(),
  persistFaircampReleases: vi.fn(),
  persistReleaseDetail: vi.fn(),
  recordCatalogOutcome: vi.fn(),
  attachDiscoveredSource: vi.fn(),
  persistDiscogsReleases: vi.fn(),
  persistJamcoopReleases: vi.fn(),
  persistMirloReleases: vi.fn(),
  persistMusicBrainzEnrichment: vi.fn(),
  replaceArtistPhoto: vi.fn(),
  safeFetch: vi.fn(),
}));

vi.mock('../db', () => ({
  claimArtistForCatalog: mocks.claimArtistForCatalog,
  getArtistForCatalog: mocks.getArtistForCatalog,
  persistReleases: mocks.persistReleases,
  persistFaircampReleases: mocks.persistFaircampReleases,
  persistReleaseDetail: mocks.persistReleaseDetail,
  recordCatalogOutcome: mocks.recordCatalogOutcome,
  attachDiscoveredSource: mocks.attachDiscoveredSource,
  persistDiscogsReleases: mocks.persistDiscogsReleases,
  persistJamcoopReleases: mocks.persistJamcoopReleases,
  persistMirloReleases: mocks.persistMirloReleases,
  persistMusicBrainzEnrichment: mocks.persistMusicBrainzEnrichment,
  replaceArtistPhoto: mocks.replaceArtistPhoto,
}));

vi.mock('../safe-fetch', () => ({
  safeFetch: mocks.safeFetch,
  safeHostname: (u: string) => new URL(u).hostname,
}));

import { refreshDeadArtistPhoto, storedPhotoToCheck } from '../artist-photo-refresh';
import { handler } from '../catalog-artist-background';

// masefield-labs' stored photo, which 404s at every size; the replacement id is made up.
const DEAD = 'https://f4.bcbits.com/img/0042332926_23.jpg';
const CURRENT = 'https://f4.bcbits.com/img/0099887766_23.jpg';
const ARTIST = { name: 'Masefield Labs', imageUrl: DEAD, customImageUrl: null };

/** A Bandcamp /music page: identity, photo and one release, in the markup the parsers read. */
function musicPage({ band = 'Masefield Labs', photo = CURRENT }: { band?: string; photo?: string | null } = {}) {
  const identity = `{&quot;id&quot;:203035041,&quot;name&quot;:&quot;${band}&quot;}`;
  return `<html><head>${photo ? `<meta property="og:image" content="${photo}">` : ''}</head>
    <body><div id="pagedata" data-band="${identity}"></div>
    <ol class="editable-grid music-grid">
      <li data-item-id="album-1" data-band-id="203035041" class="music-grid-item">
        <a href="/album/release-1"><p class="title">Release 1</p></a>
      </li>
    </ol></body></html>`;
}

function photoResponse(status: number, contentType = 'text/html') {
  return new Response(status === 200 ? 'image bytes' : 'not found', { status, headers: { 'content-type': contentType } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.replaceArtistPhoto.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storedPhotoToCheck', () => {
  const page = { bandName: 'Masefield Labs', photo: CURRENT };

  it('checks the stored photo when the artist page shows a different Bandcamp photo', () => {
    expect(storedPhotoToCheck(ARTIST, page)).toBe(DEAD);
  });

  it("leaves an artist's own photo alone: it's what the site shows", () => {
    expect(storedPhotoToCheck({ ...ARTIST, customImageUrl: 'https://example.com/me.jpg' }, page)).toBeNull();
  });

  it("doesn't fill in a photo where none was stored", () => {
    expect(storedPhotoToCheck({ ...ARTIST, imageUrl: null }, page)).toBeNull();
  });

  it("doesn't take a photo from a page that isn't the artist's, such as their label's", () => {
    expect(storedPhotoToCheck(ARTIST, { ...page, bandName: 'Hand Drawn Dracula' })).toBeNull();
    expect(storedPhotoToCheck(ARTIST, { ...page, bandName: null })).toBeNull();
  });

  it('only takes a photo from Bandcamp\'s image host', () => {
    expect(storedPhotoToCheck(ARTIST, { ...page, photo: null })).toBeNull();
    expect(storedPhotoToCheck(ARTIST, { ...page, photo: 'https://example.com/photo.jpg' })).toBeNull();
  });

  it("doesn't check a photo the page still shows, at another size", () => {
    expect(storedPhotoToCheck(ARTIST, { ...page, photo: 'https://f4.bcbits.com/img/0042332926_10.jpg' })).toBeNull();
  });
});

describe('refreshDeadArtistPhoto', () => {
  it.each([404, 410])('replaces a stored photo whose host answers %i, with the one on their page', async status => {
    mocks.safeFetch.mockResolvedValue(photoResponse(status));

    await refreshDeadArtistPhoto('a1', ARTIST, musicPage());

    expect(mocks.safeFetch).toHaveBeenCalledWith(DEAD);
    expect(mocks.replaceArtistPhoto).toHaveBeenCalledWith('a1', DEAD, CURRENT);
  });

  it('keeps a stored photo that still loads', async () => {
    mocks.safeFetch.mockResolvedValue(photoResponse(200, 'image/jpeg'));

    await refreshDeadArtistPhoto('a1', ARTIST, musicPage());

    expect(mocks.replaceArtistPhoto).not.toHaveBeenCalled();
  });

  it("keeps a stored photo when its host didn't answer: that isn't the photo being gone", async () => {
    for (const outcome of [
      () => Promise.resolve(photoResponse(503)),
      () => Promise.resolve(photoResponse(429)),
      () => Promise.resolve(null), // refused: off the safe-fetch rules or too many redirects
      () => Promise.reject(new DOMException('This operation was aborted', 'AbortError')),
    ]) {
      mocks.safeFetch.mockImplementationOnce(outcome);
      await expect(refreshDeadArtistPhoto('a1', ARTIST, musicPage())).resolves.toBeUndefined();
    }

    expect(mocks.safeFetch).toHaveBeenCalledTimes(4);
    expect(mocks.replaceArtistPhoto).not.toHaveBeenCalled();
  });

  it("doesn't fetch a stored photo on a host off the outbound allowlist", async () => {
    const backblaze = 'https://artist-avatars.s3.us-east-005.backblazeb2.com/45e7c310-x600.webp';

    await refreshDeadArtistPhoto('a1', { ...ARTIST, imageUrl: backblaze }, musicPage());

    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.replaceArtistPhoto).not.toHaveBeenCalled();
  });

  it("makes no request at all when there's nothing to repair", async () => {
    await refreshDeadArtistPhoto('a1', { ...ARTIST, customImageUrl: 'https://example.com/me.jpg' }, musicPage());
    await refreshDeadArtistPhoto('a1', ARTIST, musicPage({ band: 'Some Label' }));
    await refreshDeadArtistPhoto('a1', ARTIST, musicPage({ photo: null }));

    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });
});

describe('the Bandcamp catalogue pass', () => {
  const SECRET = 'test-secret-value';
  const ARTIST_ID = '00000000-1111-1111-1111-111111111111';
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.INTERNAL_FUNCTION_SECRET = SECRET;
    process.env.RELEASE_CATALOG_ENABLED = 'true';
    process.env.URL = 'https://unstream.stream';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // MusicBrainz enrichment runs for every artist; declining it keeps this about Bandcamp.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    mocks.claimArtistForCatalog.mockResolvedValue(true);
    mocks.persistReleases.mockResolvedValue([]);
    mocks.safeFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === DEAD
          ? photoResponse(404)
          : { ok: true, status: 200, url, text: () => Promise.resolve(musicPage()) }
      )
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  async function catalogue(artist: Record<string, unknown>) {
    mocks.getArtistForCatalog.mockResolvedValue({
      bandcampUrl: 'https://masefieldlabs.bandcamp.com',
      discogsUrl: null,
      faircampUrl: null,
      jamcoopUrl: null,
      mirloUrl: null,
      officialSiteUrl: null,
      ...artist,
    });
    const run = handler({
      httpMethod: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ artistIds: [ARTIST_ID], trigger: 'scheduled' }),
    });
    await vi.runAllTimersAsync();
    return run;
  }

  it("replaces a deleted photo with the one on the /music page it fetched for the grid", async () => {
    const response = await catalogue(ARTIST);

    expect(response.statusCode).toBe(200);
    expect(mocks.safeFetch).toHaveBeenCalledWith('https://masefieldlabs.bandcamp.com/music', expect.anything());
    expect(mocks.replaceArtistPhoto).toHaveBeenCalledWith(ARTIST_ID, DEAD, CURRENT);
  });

  it("leaves a claimed artist's own photo alone, without checking anything", async () => {
    await catalogue({ ...ARTIST, customImageUrl: 'https://example.com/me.jpg' });

    expect(mocks.safeFetch).not.toHaveBeenCalledWith(DEAD);
    expect(mocks.replaceArtistPhoto).not.toHaveBeenCalled();
  });
});
