import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The weekly posts' photo check lives in scripts/ beside the generator that uses it; see
// social-post-templates.test.ts for why those scripts are tested with the web app.
import { checkPhoto, livePhotoUrl, photoVerdict } from '../../../../scripts/social-post-photos';

// Cases measured against the verified pool on 2026-10-02: Bandcamp answers a deleted photo with a
// 404 page, and Mirlo serves real WebP avatars as application/octet-stream.
const DELETED_BANDCAMP = 'https://f4.bcbits.com/img/0042332926_23.jpg';
const MIRLO_AVATAR = 'https://cdn.mirlo.space/file/artist-avatars/d2ba6578-0edc-400e-bfd6-021e499c837a-x600.webp';

function respond(status: number, contentType: string | null) {
  const headers = contentType ? { 'content-type': contentType } : undefined;
  return vi.fn(async () => new Response('body', { status, headers }));
}

describe('photoVerdict', () => {
  it('calls a photo gone only when the host says it has none', () => {
    expect(photoVerdict(404, 'text/html')).toBe('gone');
    expect(photoVerdict(410, null)).toBe('gone');
  });

  it('calls a success that carries an image live', () => {
    expect(photoVerdict(200, 'image/jpeg')).toBe('live');
    expect(photoVerdict(200, 'image/webp')).toBe('live');
  });

  it("doesn't take an error that may be passing for an answer", () => {
    for (const status of [500, 502, 503, 504, 429, 403]) {
      expect(photoVerdict(status, 'text/html')).toBe('unknown');
    }
  });

  it("doesn't call a success gone because its content type is generic", () => {
    expect(photoVerdict(200, 'application/octet-stream')).toBe('unknown');
    expect(photoVerdict(200, null)).toBe('unknown');
  });
});

describe('checkPhoto', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports what the host answered', async () => {
    vi.stubGlobal('fetch', respond(404, 'text/html'));
    expect(await checkPhoto(DELETED_BANDCAMP)).toEqual({ verdict: 'gone', detail: '404 text/html' });
  });

  it('treats a timeout or network error as unknown, not as no photo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
    expect((await checkPhoto(DELETED_BANDCAMP)).verdict).toBe('unknown');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await checkPhoto(DELETED_BANDCAMP)).toEqual({ verdict: 'unknown', detail: 'fetch failed' });
  });
});

describe('livePhotoUrl', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('drops a photo the host says is gone, and says so', async () => {
    vi.stubGlobal('fetch', respond(404, 'text/html'));
    expect(await livePhotoUrl({ name: 'Masefield Labs', imageUrl: DELETED_BANDCAMP })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Masefield Labs: their stored photo is gone'));
  });

  it('keeps a photo whose host is down: it may be back by publish day', async () => {
    for (const fetchFn of [respond(503, 'text/html'), vi.fn(async () => { throw new TypeError('fetch failed'); })]) {
      vi.stubGlobal('fetch', fetchFn);
      expect(await livePhotoUrl({ name: 'Darpsyx', imageUrl: DELETED_BANDCAMP })).toBe(DELETED_BANDCAMP);
    }
  });

  it('keeps a live photo, and a Mirlo avatar served without an image content type', async () => {
    vi.stubGlobal('fetch', respond(200, 'image/jpeg'));
    expect(await livePhotoUrl({ name: 'A', imageUrl: DELETED_BANDCAMP })).toBe(DELETED_BANDCAMP);

    vi.stubGlobal('fetch', respond(200, 'application/octet-stream'));
    expect(await livePhotoUrl({ name: 'Gribbles', imageUrl: MIRLO_AVATAR })).toBe(MIRLO_AVATAR);
  });

  it('checks the full-size rendition the posts send, and returns the stored URL', async () => {
    const fetchFn = respond(200, 'image/jpeg');
    vi.stubGlobal('fetch', fetchFn);
    expect(await livePhotoUrl({ name: 'A', imageUrl: DELETED_BANDCAMP })).toBe(DELETED_BANDCAMP);
    expect(fetchFn).toHaveBeenCalledWith('https://f4.bcbits.com/img/0042332926_10.jpg', expect.anything());
  });

  it("doesn't fetch anything for an artist with no photo", async () => {
    const fetchFn = respond(200, 'image/jpeg');
    vi.stubGlobal('fetch', fetchFn);
    expect(await livePhotoUrl({ name: 'A', imageUrl: null })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
