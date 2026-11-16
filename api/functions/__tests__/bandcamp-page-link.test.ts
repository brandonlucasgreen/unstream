import { describe, it, expect } from 'vitest';
import { isBandcampPageLink } from '../search-sources';

// Search reads an artist's Bandcamp /music page and then follows the first release link on it for
// a date. That link is markup somebody else wrote, so it is only followed on the page's own host
// or on bandcamp.com; safeFetch then checks where the host actually resolves.
describe('isBandcampPageLink', () => {
  const page = 'https://honeycrush-online.bandcamp.com/music';

  it('follows a link on the page\'s own host', () => {
    expect(isBandcampPageLink('https://honeycrush-online.bandcamp.com/album/demo', page)).toBe(true);
  });

  it('follows a link to another Bandcamp account, as a label\'s grid has', () => {
    expect(isBandcampPageLink('https://someartist.bandcamp.com/album/split', page)).toBe(true);
  });

  it('follows a link on the custom domain the page redirected to', () => {
    expect(isBandcampPageLink('https://music.example.com/album/demo', page, 'https://music.example.com/music')).toBe(true);
  });

  it('refuses a link to any other host', () => {
    expect(isBandcampPageLink('https://169-254-169-254.nip.io/latest/meta-data', page)).toBe(false);
    expect(isBandcampPageLink('https://bandcamp.com.evil.example/album/demo', page)).toBe(false);
    expect(isBandcampPageLink('https://evil.example/album/demo', page, '')).toBe(false);
  });

  it('refuses something that is not a URL', () => {
    expect(isBandcampPageLink('not a url', page)).toBe(false);
  });
});
