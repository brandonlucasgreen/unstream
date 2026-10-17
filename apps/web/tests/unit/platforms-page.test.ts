import { describe, it, expect } from 'vitest';
import { supportPlatformGroups } from '../../src/pages/PlatformsPage';

// /platforms is generated from services/sources.ts. These pin the shape the page promises:
// every way to pay or borrow from an artist, and nothing that's only a profile link.
describe('supportPlatformGroups', () => {
  const groups = supportPlatformGroups();
  const platforms = groups.flatMap((g) => g.platforms);

  it('covers marketplaces, patronage, decentralized and library platforms, in that order', () => {
    expect(groups.map((g) => g.key)).toEqual(['marketplace', 'patronage', 'decentralized', 'library']);
  });

  // UNS-222: bandwagon is a buy-music storefront, so it moved decentralized → marketplace.
  // The decentralized group still renders when a future self-hosted search platform lands;
  // today it is legitimately empty (funkwhale is enrichment-only, not searchable).
  it('groups bandwagon with the marketplaces (UNS-222)', () => {
    const marketplace = groups.find((g) => g.key === 'marketplace')!;
    expect(marketplace.platforms.map((p) => p.id)).toContain('bandwagon');
    const decentralized = groups.find((g) => g.key === 'decentralized')!;
    expect(decentralized.platforms.map((p) => p.id)).not.toContain('bandwagon');
    expect(decentralized.platforms).toHaveLength(0);
  });

  it('leaves out official and social links', () => {
    expect(platforms.map((p) => p.category)).not.toContain('official');
    expect(platforms.map((p) => p.category)).not.toContain('social');
  });

  it('matches the "17+" platform count the press kit and site copy use', () => {
    expect(platforms.length).toBeGreaterThanOrEqual(17);
  });

  it('includes the profile-only patronage options an artist can paste a link for (UNS-217)', () => {
    for (const id of ['venmo', 'paypal'] as const) {
      const p = platforms.find((pl) => pl.id === id);
      expect(p, id).toBeDefined();
      expect(p!.category).toBe('patronage');
      // No payout figure on purpose: neither company publishes an artist share, so the cards
      // must show nothing rather than a guess.
      expect(p!.artistPayoutPercent).toBeUndefined();
    }
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
