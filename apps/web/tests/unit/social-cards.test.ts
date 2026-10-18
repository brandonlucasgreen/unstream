import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The weekly Instagram cards: drawn by the generator when it schedules the week, uploaded to R2,
// and handed to Buffer by URL. See social-post-templates.test.ts for why scripts/ is tested here.
// The renderer runs for real, so a passing render is a real PNG drawn with the bundled fonts.
import { renderSocialCard } from '../../../../scripts/social-card-render';
import {
  cardBucketFromEnv,
  cardKey,
  fetchCardImage,
  isCardImageHost,
  publishCard,
  withDrawnCards,
  type CardBucket,
} from '../../../../scripts/social-cards';
import type { SocialPost } from '../../../../scripts/social-post-templates';
import type { CardData } from '../../../../api/shared/social-card';

// A valid 1×1 PNG, enough for resvg to decode and draw.
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WEBP_HEADER = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'binary');

const DATA: CardData = {
  artistName: 'Kid Lightbulbs',
  location: 'Boston',
  platform: { id: 'bandcamp', name: 'Bandcamp', payout: '80-85%' },
  release: { title: 'any day now', type: 'album', latest: true, artworkUrl: 'https://f4.bcbits.com/img/a1011057568_2.jpg' },
  imageUrl: 'https://f4.bcbits.com/img/0032895476_23.jpg',
};

const BUCKET: CardBucket = {
  name: 'unstream-social-cards',
  publicBaseUrl: 'https://cards.unstream.stream',
  accountId: 'acct123',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
};

function pngSize(png: Uint8Array): { width: number; height: number } {
  const bytes = Buffer.from(png);
  expect(bytes.subarray(0, 4).toString('binary')).toBe('\x89PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The request a fetch mock was called with, whether it got a Request (aws4fetch) or a URL. */
function requestOf(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(new Uint8Array(PIXEL_PNG), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('renderSocialCard', () => {
  it('draws every slide as a 1080×1350 PNG', async () => {
    const image = { mimeType: 'image/png' as const, bytes: new Uint8Array(PIXEL_PNG) };
    expect(pngSize(await renderSocialCard('buy', DATA, null))).toEqual({ width: 1080, height: 1350 });
    expect(pngSize(await renderSocialCard('math', DATA, null))).toEqual({ width: 1080, height: 1350 });
    expect(pngSize(await renderSocialCard('record', DATA, image))).toEqual({ width: 1080, height: 1350 });
    expect(pngSize(await renderSocialCard('photo', DATA, image))).toEqual({ width: 1080, height: 1350 });
  });

  it('draws a name full of XML specials without breaking the SVG', async () => {
    const png = await renderSocialCard('buy', { ...DATA, artistName: `Tom & Jerry <3 "Live" 'n' >` }, null);
    expect(pngSize(png).width).toBe(1080);
  });
});

describe('the image hosts a card may draw from', () => {
  it('allows the platforms’ image CDNs over https', () => {
    for (const url of [
      'https://f4.bcbits.com/img/a1_10.jpg',
      'https://cdn.mirlo.space/file/trackgroup-covers/x-x1500.jpg',
      'https://yt3.googleusercontent.com/abc=s900',
      'https://images.subvert.fm/cover.jpg',
      'https://cdn.jam.coop/cover.png',
      'https://artist.faircamp.net/cover.jpg',
    ]) {
      expect(isCardImageHost(url)).toBe(true);
    }
  });

  it('refuses anything else, including what an artist could type in as their image', () => {
    for (const url of [
      'http://f4.bcbits.com/img/a1_10.jpg',
      'http://169.254.169.254/latest/meta-data/cover.jpg',
      'https://169-254-169-254.nip.io/cover.jpg',
      'https://bcbits.com.evil.example/cover.jpg',
      'https://faircamp.evil.example/cover.jpg',
      'https://images.example.com/me.jpg',
      'not a url',
    ]) {
      expect(isCardImageHost(url)).toBe(false);
    }
  });
});

describe('fetchCardImage', () => {
  it('fetches the full-size rendition without following redirects', async () => {
    const image = await fetchCardImage('https://f4.bcbits.com/img/a1011057568_2.jpg');
    expect(image.mimeType).toBe('image/png');
    expect(fetchMock).toHaveBeenCalledWith('https://f4.bcbits.com/img/a1011057568_10.jpg', expect.objectContaining({ redirect: 'error' }));
  });

  it('never fetches from a host off the list', async () => {
    await expect(fetchCardImage('http://169.254.169.254/latest/meta-data/cover.jpg')).rejects.toThrow('image host not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an image that's gone, or one resvg can't decode", async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 404 }));
    await expect(fetchCardImage(DATA.imageUrl!)).rejects.toThrow('returned 404');

    fetchMock.mockImplementation(async () => new Response(new Uint8Array(WEBP_HEADER), { status: 200 }));
    await expect(fetchCardImage(DATA.imageUrl!)).rejects.toThrow('not a JPEG or PNG');
  });
});

describe('cardKey', () => {
  it('names a card by artist, slide and the hash of its bytes', () => {
    const png = new Uint8Array([1, 2, 3]);
    expect(cardKey('kid-lightbulbs', 'buy', png)).toMatch(/^cards\/kid-lightbulbs\/buy-[0-9a-f]{16}\.png$/);
    expect(cardKey('kid-lightbulbs', 'buy', png)).toBe(cardKey('kid-lightbulbs', 'buy', new Uint8Array([1, 2, 3])));
  });

  it('never gives different bytes the same key, so a re-run cannot overwrite a scheduled card', () => {
    expect(cardKey('kid-lightbulbs', 'buy', new Uint8Array([1]))).not.toBe(cardKey('kid-lightbulbs', 'buy', new Uint8Array([2])));
  });

  it('refuses a slug that would make the key anything but a plain path', () => {
    expect(() => cardKey('../other', 'buy', new Uint8Array([1]))).toThrow();
    expect(() => cardKey('Kid_Lightbulbs', 'buy', new Uint8Array([1]))).toThrow();
  });
});

describe('cardBucketFromEnv', () => {
  const ENV = {
    SOCIAL_CARDS_BUCKET: 'unstream-social-cards',
    SOCIAL_CARDS_PUBLIC_BASE_URL: 'https://cards.unstream.stream/',
    R2_ACCOUNT_ID: 'acct123',
    SOCIAL_CARDS_R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    SOCIAL_CARDS_R2_SECRET_ACCESS_KEY: 'secret',
  };

  it('reads every setting, without a trailing slash on the public address', () => {
    expect(cardBucketFromEnv(ENV)).toEqual(BUCKET);
  });

  it('fails naming every setting that is missing or blank, rather than going ahead without cards', () => {
    expect(() => cardBucketFromEnv({ ...ENV, SOCIAL_CARDS_BUCKET: undefined, SOCIAL_CARDS_R2_SECRET_ACCESS_KEY: ' ' }))
      .toThrow('SOCIAL_CARDS_BUCKET, SOCIAL_CARDS_R2_SECRET_ACCESS_KEY are not set');
    expect(() => cardBucketFromEnv({})).toThrow(/SOCIAL_CARDS_BUCKET.*SOCIAL_CARDS_PUBLIC_BASE_URL.*R2_ACCOUNT_ID/);
  });

  it('refuses a public address that is not https', () => {
    expect(() => cardBucketFromEnv({ ...ENV, SOCIAL_CARDS_PUBLIC_BASE_URL: 'cards.unstream.stream' })).toThrow('https://');
  });
});

describe('publishCard', () => {
  const KEY = 'cards/kid-lightbulbs/buy-0123456789abcdef.png';

  it('uploads a signed, immutable PNG to the bucket, then checks it at its public address', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const request = requestOf(input, init);
      if (request.method === 'PUT') return new Response('', { status: 200 });
      return new Response(new Uint8Array(PIXEL_PNG), { status: 200, headers: { 'content-type': 'image/png' } });
    });

    expect(await publishCard(BUCKET, KEY, new Uint8Array(PIXEL_PNG))).toBe(`https://cards.unstream.stream/${KEY}`);

    const upload = requestOf(...fetchMock.mock.calls[0]);
    expect(upload.method).toBe('PUT');
    expect(upload.url).toBe(`https://acct123.r2.cloudflarestorage.com/unstream-social-cards/${KEY}`);
    expect(upload.headers.get('content-type')).toBe('image/png');
    expect(upload.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(upload.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, /);
    expect(requestOf(...fetchMock.mock.calls[1]).url).toBe(`https://cards.unstream.stream/${KEY}`);
  });

  it('fails with R2’s reason when the upload is refused', async () => {
    fetchMock.mockImplementation(async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    await expect(publishCard(BUCKET, KEY, new Uint8Array(PIXEL_PNG))).rejects.toThrow('R2 upload returned 403 AccessDenied');
  });

  it('fails when the public address does not answer with the PNG, so Buffer is never handed it', async () => {
    for (const answer of [
      new Response('', { status: 404 }),
      new Response('<html>challenge</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]) {
      fetchMock.mockImplementation(async (input, init) => (requestOf(input, init).method === 'PUT' ? new Response('', { status: 200 }) : answer));
      await expect(publishCard(BUCKET, KEY, new Uint8Array(PIXEL_PNG))).rejects.toThrow('cards.unstream.stream');
    }
  });
});

describe('withDrawnCards', () => {
  const POST: SocialPost = {
    platform: 'instagram',
    text: "Today's artist: Kid Lightbulbs.",
    images: [],
    carousel: {
      data: DATA,
      slides: [
        { slide: 'buy', altText: 'buy alt' },
        { slide: 'record', altText: 'record alt' },
        { slide: 'math', altText: 'math alt' },
        { slide: 'photo', altText: 'photo alt' },
      ],
      userTags: [{ handle: 'kidlightbulbs', x: 0.5, y: 0.4 }],
    },
  };
  const ARTIST = { name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' };

  function storeAt(base: string) {
    return vi.fn(async (key: string, png: Uint8Array) => (png.length > 0 ? `${base}/${key}` : ''));
  }

  it('draws and stores every card in order, tagging the artist on the first', async () => {
    const store = storeAt('https://cards.unstream.stream');
    const drawn = await withDrawnCards(POST, ARTIST, store);

    expect(drawn?.images.map(i => i.altText)).toEqual(['buy alt', 'record alt', 'math alt', 'photo alt']);
    expect(drawn?.images[0].url).toMatch(/^https:\/\/cards\.unstream\.stream\/cards\/kid-lightbulbs\/buy-[0-9a-f]{16}\.png$/);
    expect(drawn?.images[0].userTags).toEqual([{ handle: 'kidlightbulbs', x: 0.5, y: 0.4 }]);
    expect(drawn?.images.slice(1).every(i => !i.userTags)).toBe(true);
    expect(pngSize(store.mock.calls[0][1])).toEqual({ width: 1080, height: 1350 });
  });

  it('leaves out a card whose image is gone, and says so', async () => {
    fetchMock.mockImplementation(async input => {
      const url = requestOf(input).url;
      return url.includes('0032895476') ? new Response('', { status: 404 }) : new Response(new Uint8Array(PIXEL_PNG), { status: 200 });
    });
    const drawn = await withDrawnCards(POST, ARTIST, storeAt('https://cards.unstream.stream'));
    expect(drawn?.images.map(i => i.altText)).toEqual(['buy alt', 'record alt', 'math alt']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Instagram card photo wasn't drawn (image host returned 404"));
  });

  it('leaves out a card that fails to upload, moving the tag to the card that is now first', async () => {
    const store = vi.fn(async (key: string) => {
      if (key.includes('/buy-')) throw new Error('R2 upload returned 403 AccessDenied');
      return `https://cards.unstream.stream/${key}`;
    });
    const drawn = await withDrawnCards(POST, ARTIST, store);
    expect(drawn?.images.map(i => i.altText)).toEqual(['record alt', 'math alt', 'photo alt']);
    expect(drawn?.images[0].userTags).toEqual([{ handle: 'kidlightbulbs', x: 0.5, y: 0.4 }]);
  });

  it('gives no post at all when no card was stored', async () => {
    const store = vi.fn(async () => { throw new Error('cards.unstream.stream answered 404'); });
    expect(await withDrawnCards(POST, ARTIST, store)).toBeNull();
  });
});
