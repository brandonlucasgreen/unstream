// @vitest-environment jsdom
// The header's Account menu.
//
// What's worth locking: Curator Posts is listed only for the admin, the one account the server
// lets into the tool while the curatorPosts flag is off (canUseCuratorPosts). Anyone else
// following the link would land on "not switched on yet".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NavEntry } from 'src/components/MobileNav';
import { Header } from 'src/components/Header';

const auth = vi.hoisted(() => ({ isAdmin: false }));

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 't' }, user: { email: 'x@example.com' }, isAdmin: auth.isAdmin, signOut: vi.fn() }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('src/components/HeaderSearch', () => ({ HeaderSearch: () => null }));
vi.mock('src/components/NavDropdown', () => ({ NavDropdown: () => null }));

// The drawer only renders its links while open; flatten the entries it is given instead.
vi.mock('src/components/MobileNav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/components/MobileNav')>()),
  MobileNav: ({ items }: { items: NavEntry[] }) => (
    <ul>
      {items.flatMap(e => ('items' in e ? e.items : [e])).map(i => <li key={i.to} data-to={i.to}>{i.label}</li>)}
    </ul>
  ),
}));

vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));

const accountLinks = () => Array.from(document.querySelectorAll('li[data-to]')).map(li => li.getAttribute('data-to'));

function renderHeader() {
  return render(<MemoryRouter><Header /></MemoryRouter>);
}

afterEach(cleanup);

describe('Header account menu', () => {
  it('lists Curator Posts for the admin, between My Collection and Settings', () => {
    auth.isAdmin = true;
    renderHeader();
    const links = accountLinks();
    expect(links.slice(links.indexOf('/my-artists'))).toEqual(['/my-artists', '/my-collection', '/curator/new', '/settings']);
    expect(screen.getByText('nav.account.curatorPosts')).toBeTruthy();
  });

  it('leaves it out for everyone else', () => {
    auth.isAdmin = false;
    renderHeader();
    expect(accountLinks()).toEqual(['/my-artists', '/my-collection', '/settings']);
  });
});
