// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MobileNav, type NavItem } from 'src/components/MobileNav';

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

function openMenu() {
  fireEvent.click(screen.getByLabelText('Open menu'));
}

describe('MobileNav', () => {
  afterEach(() => {
    cleanup();
  });

  it('hides the menu items until the hamburger is clicked', () => {
    render(<MobileNav items={loggedInItems} />);
    expect(screen.queryByText('Dashboard')).toBeNull();

    openMenu();
    expect(screen.getByText('Dashboard')).toBeTruthy();
  });

  it('shows only Login when signed out', () => {
    render(<MobileNav items={loggedOutItems} />);
    openMenu();

    expect(screen.getByText('Login')).toBeTruthy();
    expect(screen.queryByText('Sign out')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('shows the account links, email and sign out when signed in', () => {
    render(<MobileNav items={loggedInItems} email="fan@example.com" onSignOut={() => {}} />);
    openMenu();

    expect(screen.getByText('fan@example.com')).toBeTruthy();
    expect(screen.getByText('Dashboard').getAttribute('href')).toBe('/dashboard');
    expect(screen.getByText('Settings').getAttribute('href')).toBe('/settings');
    expect(screen.getByText('Sign out')).toBeTruthy();
  });

  it('calls onSignOut and closes the menu', () => {
    const onSignOut = vi.fn();
    render(<MobileNav items={loggedInItems} onSignOut={onSignOut} />);
    openMenu();

    fireEvent.click(screen.getByText('Sign out'));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.queryByText('Dashboard')).toBeNull();
  });

  it('closes when a link is clicked, so a same-route tap does not leave it open', () => {
    render(<MobileNav items={loggedInItems} />);
    openMenu();

    fireEvent.click(screen.getByText('Settings'));
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('closes on Escape and on a click outside', () => {
    render(<MobileNav items={loggedInItems} />);

    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Dashboard')).toBeNull();

    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Dashboard')).toBeNull();
  });

  it('reflects open state for screen readers', () => {
    render(<MobileNav items={loggedInItems} />);
    expect(screen.getByLabelText('Open menu').getAttribute('aria-expanded')).toBe('false');

    openMenu();
    expect(screen.getByLabelText('Close menu').getAttribute('aria-expanded')).toBe('true');
  });
});
