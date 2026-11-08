// @vitest-environment jsdom
// The header's artist menu, for a non-admin artist. Its Tips and Promote items follow the
// server's answer (/api/me/artist-nav), never `isAdmin` — the 2026-11-05 Promote launch was
// invisible to every artist because a button was gated on `isAdmin`, which the admin can't notice.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NavEntry } from 'src/components/MobileNav';
import type { ArtistNav } from 'src/services/artistNav';

const state = vi.hoisted(() => ({ nav: null as ArtistNav | null }));

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 't' }, user: { id: 'u1', email: 'artist@example.com' }, isAdmin: false, signOut: vi.fn() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('src/components/HeaderSearch', () => ({ HeaderSearch: () => null }));
vi.mock('src/components/NavDropdown', () => ({ NavDropdown: () => null }));
vi.mock('src/services/artistNav', async importOriginal => ({
  ...(await importOriginal<typeof import('src/services/artistNav')>()),
  getArtistNav: async () => state.nav,
}));
vi.mock('src/components/MobileNav', async importOriginal => ({
  ...(await importOriginal<typeof import('src/components/MobileNav')>()),
  MobileNav: ({ items }: { items: NavEntry[] }) => (
    <ul>
      {items.map(e => ('items' in e ? <li key={e.label} data-group={e.label} /> : null))}
      {items.flatMap(e => ('items' in e ? e.items : [e])).map(i => <li key={i.to} data-to={i.to}>{i.label}</li>)}
    </ul>
  ),
}));
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));

import { Header } from 'src/components/Header';

const links = () => Array.from(document.querySelectorAll('li[data-to]')).map(li => li.getAttribute('data-to'));
const groups = () => Array.from(document.querySelectorAll('li[data-group]')).map(li => li.getAttribute('data-group'));

afterEach(cleanup);

describe('Header artist menu', () => {
  it("gives a non-admin artist a menu named after them, with Tips and Promote once the server opens them", async () => {
    state.nav = { artists: [{ name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' }], tips: true, promote: true };
    render(<MemoryRouter><Header /></MemoryRouter>);
    await waitFor(() => expect(groups()).toContain('Kid Lightbulbs'));
    expect(links()).toEqual(expect.arrayContaining(['/analytics/kid-lightbulbs', '/tips/kid-lightbulbs', '/promote/kid-lightbulbs']));
    // Before the account menu, after nothing else for a non-admin.
    expect(groups()).toEqual(['Kid Lightbulbs', 'nav.account.label']);
  });

  it('has no artist menu for a fan', async () => {
    state.nav = { artists: [], tips: false, promote: false };
    render(<MemoryRouter><Header /></MemoryRouter>);
    await waitFor(() => expect(groups()).toEqual(['nav.account.label']));
    expect(links().some(to => to?.startsWith('/analytics/'))).toBe(false);
  });
});
