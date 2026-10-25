// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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

// The drawer is a modal <dialog> (see Dialog.tsx), mounted only while open: the browser makes the
// page behind it inert and keeps Tab inside it, which the old always-mounted overlay didn't.
function dialog() {
  return document.querySelector('dialog');
}
function isOpen() {
  return trigger().getAttribute('aria-expanded') === 'true' && !!dialog()?.hasAttribute('open');
}

describe('MobileNav', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts closed, with no drawer on the page', () => {
    render(<MobileNav items={loggedInItems} />);

    expect(isOpen()).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('opens as a modal dialog named by the menu when the hamburger is clicked', () => {
    render(<MobileNav items={loggedInItems} />);

    fireEvent.click(trigger());
    expect(isOpen()).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Main menu' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main menu' })).toBeTruthy();
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

  // Escape is the browser's: it fires `cancel` on the dialog, then closes it. The old drawer's own
  // Escape handler closed without returning focus to the hamburger.
  it('closes on Escape, on the close button and on a backdrop tap, refocusing the hamburger', () => {
    render(<MobileNav items={loggedInItems} />);

    fireEvent.click(trigger());
    fireEvent(dialog()!, new Event('cancel', { cancelable: true }));
    dialog()!.close();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());

    fireEvent.click(trigger());
    fireEvent.click(screen.getByLabelText('Close menu'));
    expect(isOpen()).toBe(false);

    fireEvent.click(trigger());
    // A click on the <dialog> element itself is a click on its backdrop.
    fireEvent.click(dialog()!);
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
