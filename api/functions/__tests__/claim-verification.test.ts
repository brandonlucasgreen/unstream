import { describe, it, expect } from 'vitest';
import { websiteMatchesKnownLink, type StoredLink } from '../claim-verification';

// A claim is approved instantly only when the website it verified on is one we already hold
// for the artist from a source other than a claimant. Anything else goes to manual review.

const link = (platform: string, url: string, source: string | null = 'auto'): StoredLink => ({
  platform,
  url,
  source,
});

describe('websiteMatchesKnownLink', () => {
  it('matches the official site MusicBrainz gave us, ignoring www, scheme and path', () => {
    const links = [link('officialsite', 'https://www.kidlightbulbs.com/')];
    expect(websiteMatchesKnownLink('http://kidlightbulbs.com/about', links)).toBe(true);
  });

  it("matches the artist's Bandcamp subdomain", () => {
    const links = [link('bandcamp', 'https://kidlightbulbs.bandcamp.com/music')];
    expect(websiteMatchesKnownLink('https://kidlightbulbs.bandcamp.com/', links)).toBe(true);
  });

  // The takeover this closes: any page that names the artist and links back used to verify.
  it('does not match a site we hold nothing for', () => {
    const links = [link('officialsite', 'https://radiohead.com/')];
    expect(websiteMatchesKnownLink('https://radiohead-official.pages.dev/', links)).toBe(false);
  });

  it('does not match a different Bandcamp account', () => {
    const links = [link('bandcamp', 'https://honeycrush-online.bandcamp.com/')];
    expect(websiteMatchesKnownLink('https://honeycrush.bandcamp.com/', links)).toBe(false);
  });

  it('ignores links a claimant added', () => {
    const links = [link('officialsite', 'https://example-artist.com/', 'claimed')];
    expect(websiteMatchesKnownLink('https://example-artist.com/', links)).toBe(false);
  });

  it('only trusts identifying platforms, not socials', () => {
    const links = [link('instagram', 'https://evil.example/')];
    expect(websiteMatchesKnownLink('https://evil.example/', links)).toBe(false);
  });

  it('compares the account path on shared hosts, never the bare host', () => {
    const links = [link('officialsite', 'https://linktr.ee/kidlightbulbs')];
    expect(websiteMatchesKnownLink('https://linktr.ee/kidlightbulbs', links)).toBe(true);
    expect(websiteMatchesKnownLink('https://linktr.ee/someone-else', links)).toBe(false);
    expect(websiteMatchesKnownLink('https://linktr.ee/', [link('officialsite', 'https://linktr.ee/')])).toBe(false);
  });

  it('rejects unparseable and non-http URLs', () => {
    const links = [link('officialsite', 'https://example-artist.com/')];
    expect(websiteMatchesKnownLink('not a url', links)).toBe(false);
    expect(websiteMatchesKnownLink('javascript:alert(1)', links)).toBe(false);
  });
});
