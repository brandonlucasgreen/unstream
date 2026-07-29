// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MobileNav, type NavEntry, type NavItem } from 'src/components/MobileNav';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, onClick, className }: {
    children: ReactNode;
    to: string;
    onClick?: () => void;
    className?: string;
  }) => <a href={to} onClick={onClick} className={className}>{children}</a>,
}));

const loggedOutItems: NavItem[] = [{ to: '/login', label: 'Login' }];
const loggedInItems: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', emphasis: true },
  { to: '/settings', label: 'Settings' },
];

function trigger() {
  return screen.getByLabelText('Open menu');
}

// The drawer stays mounted so it can animate shut, so "closed" means inert and
// translated off-screen rather than absent from the DOM.
function drawer() {
  return screen.getByLabelText('Main menu');
}
function isOpen() {
  return trigger().getAttribute('aria-expanded') === 'true'
    && !drawer().parentElement?.hasAttribute('inert')
    && drawer().className.includes('translate-x-0');
}

describe('MobileNav', () => {
  afterEach(() => {
    cleanup();
  });

  it('starts closed, with the drawer inert and off-screen', () => {
    render(<MobileNav items={loggedInItems} />);

    expect(isOpen()).toBe(false);
    expect(drawer().className).toContain('translate-x-full');
    expect(drawer().parentElement?.hasAttribute('inert')).toBe(true);
  });

  it('slides open when the hamburger is clicked', () => {
    render(<MobileNav items={loggedInItems} />);

    fireEvent.click(trigger());
    expect(isOpen()).toBe(true);
  });

  it('shows only Login when signed out', () => {
    render(<MobileNav items={loggedOutItems} />);
    fireEvent.click(trigger());

    expect(screen.getByText('Login').getAttribute('href')).toBe('/login');
    expect(screen.queryByText('Sign out')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('shows the account links, email and sign out when signed in', () => {
    render(<MobileNav items={loggedInItems} email="fan@example.com" onSignOut={() => {}} />);
    fireEvent.click(trigger());

    expect(screen.getByText('fan@example.com')).toBeTruthy();
    expect(screen.getByText('Dashboard').getAttribute('href')).toBe('/dashboard');
    expect(screen.getByText('Settings').getAttribute('href')).toBe('/settings');
    expect(screen.getByText('Sign out')).toBeTruthy();
  });

  it('calls onSignOut and closes', () => {
    const onSignOut = vi.fn();
    render(<MobileNav items={loggedInItems} onSignOut={onSignOut} />);
    fireEvent.click(trigger());

    fireEvent.click(screen.getByText('Sign out'));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(isOpen()).toBe(false);
  });

  it('closes when a link is tapped, so a same-route tap does not leave it open', () => {
    render(<MobileNav items={loggedInItems} />);
    fireEvent.click(trigger());

    fireEvent.click(screen.getByText('Settings'));
    expect(isOpen()).toBe(false);
  });

  it('closes on Escape, on the close button and on a backdrop tap', () => {
    render(<MobileNav items={loggedInItems} />);

    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isOpen()).toBe(false);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByLabelText('Close menu'));
    expect(isOpen()).toBe(false);

    fireEvent.click(trigger());
    fireEvent.click(drawer().previousElementSibling as Element);
    expect(isOpen()).toBe(false);
  });

  it('locks page scroll while open and restores it on close', () => {
    render(<MobileNav items={loggedInItems} />);

    fireEvent.click(trigger());
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByLabelText('Close menu'));
    expect(document.body.style.overflow).toBe('');
  });

  it('moves focus to the close button on open and back to the hamburger on close', () => {
    render(<MobileNav items={loggedInItems} />);

    fireEvent.click(trigger());
    expect(document.activeElement).toBe(screen.getByLabelText('Close menu'));

    fireEvent.click(screen.getByLabelText('Close menu'));
    expect(document.activeElement).toBe(trigger());
  });

  // A scrolling focus makes the browser scroll the clipped overlay sideways to
  // reveal the still-off-screen panel, which snaps it into place and fights the
  // slide-in. Both focus calls must opt out.
  it('focuses without scrolling', () => {
    const focus = vi.spyOn(HTMLButtonElement.prototype, 'focus');
    render(<MobileNav items={loggedInItems} />);

    fireEvent.click(trigger());
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });

    fireEvent.click(screen.getByLabelText('Close menu'));
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });

    focus.mockRestore();
  });

  // Admin pages arrive as a group. The drawer shows them as a labelled block of
  // links rather than another tap-to-expand level.
  it('renders a nav group as a heading plus its links', () => {
    const items: NavEntry[] = [
      {
        label: 'Admin',
        emphasis: true,
        items: [
          { to: '/admin/verify', label: 'Verify (2)', emphasis: true },
          { to: '/admin/links', label: 'Removed links' },
          { to: '/admin/analytics', label: 'Analytics' },
        ],
      },
      ...loggedInItems,
    ];

    render(<MobileNav items={items} />);
    fireEvent.click(trigger());

    expect(screen.getByText('Admin')).toBeTruthy();
    for (const label of ['Verify (2)', 'Removed links', 'Analytics', 'Dashboard', 'Settings']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('Removed links').getAttribute('href')).toBe('/admin/links');
  });
});
