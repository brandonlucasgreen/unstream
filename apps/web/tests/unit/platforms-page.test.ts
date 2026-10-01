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

  it('leaves out official and social links', () => {
    expect(platforms.map((p) => p.category)).not.toContain('official');
    expect(platforms.map((p) => p.category)).not.toContain('social');
  });

  it('matches the "17+" platform count the press kit and site copy use', () => {
    expect(platforms.length).toBeGreaterThanOrEqual(17);
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
