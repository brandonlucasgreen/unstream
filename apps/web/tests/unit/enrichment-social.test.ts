import { describe, it, expect } from 'vitest';
import {
  isMastodonInstance,
  isPeerTubeInstance,
  parseSocialUrl,
} from '../../../../api/search/enrichment';

// The bug these guard: instance matching used substring-of-the-whole-URL, and the
// instance list contains short domains like "c.im". A Wix asset URL whose
// URL-encoded query string contained "...%2C.imageEncoding..." matched "c.im" and
// shipped as an artist's "Mastodon profile". Matching must be by hostname.

describe('isMastodonInstance', () => {
  it('matches a profile on a known instance', () => {
    expect(isMastodonInstance('https://mastodon.social/@artist')).toBe(true);
    expect(isMastodonInstance('https://c.im/@someone')).toBe(true);
  });

  it('matches subdomains of a known instance', () => {
    expect(isMastodonInstance('https://media.mastodon.social/whatever')).toBe(true);
  });

  it('rejects URLs that merely contain an instance name as a substring', () => {
    // The actual Wix asset URL bug: "%2C.imageEncodingAVIF" contains "c.im".
    expect(isMastodonInstance(
      'https://siteassets.parastorage.com/pages/thunderbolt?experiments=.dynamicslots%2c.imageencodingavif'
    )).toBe(false);
    // A domain that ends with the instance string without being a subdomain.
    expect(isMastodonInstance('https://public.im/@x')).toBe(false);
    expect(isMastodonInstance('https://notmastodon.social.example.com/@x')).toBe(false);
  });

  it('rejects unparseable URLs', () => {
    expect(isMastodonInstance('not a url')).toBe(false);
  });
});

describe('isPeerTubeInstance', () => {
  it('matches a known instance by hostname', () => {
    expect(isPeerTubeInstance('https://tilvids.com/c/channel')).toBe(true);
  });

  it('rejects substring-only matches', () => {
    expect(isPeerTubeInstance('https://example.com/?ref=tilvids.com')).toBe(false);
  });
});

describe('parseSocialUrl', () => {
  it('still classifies mainstream platforms', () => {
    expect(parseSocialUrl('https://www.instagram.com/artist')?.platform).toBe('instagram');
    expect(parseSocialUrl('https://bsky.app/profile/artist')?.platform).toBe('bluesky');
  });

  it('classifies known Mastodon instances by hostname only', () => {
    expect(parseSocialUrl('https://mastodon.art/@artist')?.platform).toBe('mastodon');
    expect(parseSocialUrl(
      'https://siteassets.parastorage.com/x?y=%2c.imageencodingavif'
    )).toBeNull();
  });
});
