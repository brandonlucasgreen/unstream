// Release autopost images: telling what an image is and whether Instagram will take it, from the
// file itself, before Buffer finds out on publish day.

import { describe, it, expect } from 'vitest';
import { fitsInstagram, imageSize, mediaBucketFromEnv, sniffImage } from '../autopost-media';

/** A PNG with just enough header: signature, then an IHDR with width and height. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A JPEG: SOI, an APP0 segment to skip, then a baseline SOF0 frame with its size. */
function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0]);
}

describe('reading an image', () => {
  it('knows a JPEG and a PNG by their first bytes, and nothing else', () => {
    expect(sniffImage(jpeg(10, 10))).toBe('image/jpeg');
    expect(sniffImage(png(10, 10))).toBe('image/png');
    expect(sniffImage(new TextEncoder().encode('RIFF....WEBP'))).toBeNull();
  });

  it('reads the size from the header', () => {
    expect(imageSize(png(1080, 1350))).toEqual({ width: 1080, height: 1350 });
    expect(imageSize(jpeg(1200, 700))).toEqual({ width: 1200, height: 700 });
  });

  it('gives up on a header it can’t read', () => {
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe('fitsInstagram', () => {
  it('takes 4:5 portrait to 1.91:1 landscape', () => {
    expect(fitsInstagram({ width: 1080, height: 1350 })).toBe(true);
    expect(fitsInstagram({ width: 1000, height: 1000 })).toBe(true);
    expect(fitsInstagram({ width: 1910, height: 1000 })).toBe(true);
    expect(fitsInstagram({ width: 1000, height: 1300 })).toBe(false);
    expect(fitsInstagram({ width: 2000, height: 1000 })).toBe(false);
  });
});

describe('mediaBucketFromEnv', () => {
  const env = {
    SOCIAL_CARDS_BUCKET: 'unstream-social-cards',
    SOCIAL_CARDS_PUBLIC_BASE_URL: 'https://cards.unstream.stream/',
    R2_ACCOUNT_ID: 'acct',
    SOCIAL_CARDS_R2_ACCESS_KEY_ID: 'key',
    SOCIAL_CARDS_R2_SECRET_ACCESS_KEY: 'secret',
  };

  it('reads the social cards’ bucket settings', () => {
    expect(mediaBucketFromEnv(env)).toMatchObject({ name: 'unstream-social-cards', publicBaseUrl: 'https://cards.unstream.stream' });
  });

  it('names every missing setting', () => {
    expect(mediaBucketFromEnv({ ...env, R2_ACCOUNT_ID: '', SOCIAL_CARDS_R2_SECRET_ACCESS_KEY: undefined }))
      .toEqual({ missing: ['R2_ACCOUNT_ID', 'SOCIAL_CARDS_R2_SECRET_ACCESS_KEY'] });
  });
});
