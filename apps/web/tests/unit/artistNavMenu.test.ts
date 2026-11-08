// The header's artist menu (services/artistNav.ts). One artist: a menu named after them. Several:
// one "Your artists" menu with a section per artist. Tips and Promote only when the server said so.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { buildArtistMenu } from 'src/services/artistNav';

const labels = {
  yourArtists: 'Your artists',
  analytics: 'Analytics',
  viewPage: 'View page',
  editPage: 'Edit page',
  releases: 'Releases',
  tips: 'Tips',
  promote: 'Promote',
};

describe('buildArtistMenu', () => {
  it('has no menu for an account without an artist, or without an answer', () => {
    expect(buildArtistMenu(null, labels)).toBeNull();
    expect(buildArtistMenu({ artists: [], tips: true, promote: true }, labels)).toBeNull();
  });

  it("names a single artist's menu after them, with all six pages", () => {
    const menu = buildArtistMenu({ artists: [{ name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' }], tips: true, promote: true }, labels);
    expect(menu?.label).toBe('Kid Lightbulbs');
    expect(menu?.items.map(i => i.to)).toEqual([
      '/a/kid-lightbulbs',
      '/artist-edit/kid-lightbulbs',
      '/analytics/kid-lightbulbs',
      '/releases/kid-lightbulbs',
      '/tips/kid-lightbulbs',
      '/promote/kid-lightbulbs',
    ]);
    expect(menu?.items.every(i => i.section === undefined)).toBe(true);
  });

  it('leaves out Tips and Promote unless the server opened them', () => {
    const menu = buildArtistMenu({ artists: [{ name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' }], tips: false, promote: false }, labels);
    expect(menu?.items.map(i => i.label)).toEqual(['View page', 'Edit page', 'Analytics', 'Releases']);
  });

  it("groups several artists' pages under each artist's name", () => {
    const menu = buildArtistMenu({
      artists: [{ name: 'Paracosm', slug: 'paracosm' }, { name: 'xParacosm', slug: 'xparacosm' }],
      tips: false,
      promote: false,
    }, labels);
    expect(menu?.label).toBe('Your artists');
    expect(menu?.items).toHaveLength(8);
    expect(menu?.items.slice(0, 4).every(i => i.section === 'Paracosm')).toBe(true);
    expect(menu?.items.slice(4).every(i => i.section === 'xParacosm')).toBe(true);
  });
});
