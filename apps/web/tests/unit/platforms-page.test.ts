import { describe, it, expect } from 'vitest';
import { supportPlatformGroups } from '../../src/pages/PlatformsPage';

// /platforms is generated from services/sources.ts. These pin the shape the page promises:
// every way to pay or borrow from an artist, and nothing that's only a profile link.
describe('supportPlatformGroups', () => {
  const groups = supportPlatformGroups();
  const platforms = groups.flatMap((g) => g.platforms);

  it('covers marketplaces, patronage and library platforms, in that order (UNS-226)', () => {
    expect(groups.map((g) => g.key)).toEqual(['marketplace', 'patronage', 'library']);
  });

  // UNS-222: bandwagon is a buy-music storefront, so it moved decentralized → marketplace.
  // UNS-226: no listing page renders the empty decentralized bucket anymore — it emptied
  // when Faircamp went official (UNS-221) and funkwhale stayed enrichment-only. A future
  // searchable self-hosted platform re-enters through its registry category (search cards
  // render data-driven), and the listing pages once the group has content again.
  it('groups bandwagon with the marketplaces (UNS-222)', () => {
    const marketplace = groups.find((g) => g.key === 'marketplace')!;
    expect(marketplace.platforms.map((p) => p.id)).toContain('bandwagon');
  });

  it('leaves out official, decentralized and social buckets', () => {
    expect(groups.map((g) => g.key)).not.toContain('official');
    // UNS-226: the empty decentralized block does not render on /platforms either.
    expect(groups.map((g) => g.key)).not.toContain('decentralized');
    expect(platforms.map((p) => p.category)).not.toContain('social');
  });

  it('matches the "17+" platform count the press kit and site copy use', () => {
    expect(platforms.length).toBeGreaterThanOrEqual(17);
  });

  it('includes the profile-only patronage options an artist can paste a link for (UNS-217)', () => {
    for (const id of ['venmo', 'paypal', 'cashapp', 'steady', 'tipeee'] as const) {
      const p = platforms.find((pl) => pl.id === id);
      expect(p, id).toBeDefined();
      expect(p!.category).toBe('patronage');
      // No payout figure on purpose: neither company publishes an artist share, so the cards
      // must show nothing rather than a guess.
      expect(p!.artistPayoutPercent).toBeUndefined();
    }
  });

  it('lists Big Cartel with the places to buy, since it is the artist\'s own shop', () => {
    const p = platforms.find((pl) => pl.id === 'bigcartel');
    expect(p).toBeDefined();
    expect(p!.category).toBe('marketplace');
    expect(p!.artistPayoutPercent).toBeUndefined();
  });

  it('gives every platform a name, description and homepage to link to', () => {
    for (const p of platforms) {
      expect(p, p.id).toBeDefined();
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.homepageUrl).toMatch(/^https:\/\//);
    }
  });
});