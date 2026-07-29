// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { NavDropdown } from 'src/components/NavDropdown';
import type { NavGroup } from 'src/components/MobileNav';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, onClick }: { children: ReactNode; to: string; onClick?: () => void }) =>
    <a href={to} onClick={onClick}>{children}</a>,
}));

const ADMIN: NavGroup = {
  label: 'Admin',
  items: [
    { to: '/admin/verify', label: 'Verify' },
    { to: '/admin/links', label: 'Removed links' },
    { to: '/admin/analytics', label: 'Analytics' },
  ],
};

function toggle() {
  return screen.getByRole('button', { name: /Admin/ });
}

describe('NavDropdown', () => {
  afterEach(cleanup);

  it('hides its links until opened', () => {
    render(<NavDropdown group={ADMIN} />);
    expect(screen.queryByText('Analytics')).toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle());

    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Removed links').getAttribute('href')).toBe('/admin/links');
    expect(screen.getByText('Analytics')).toBeTruthy();
  });

  it('closes on Escape', () => {
    render(<NavDropdown group={ADMIN} />);
    fireEvent.click(toggle());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Analytics')).toBeNull();
  });

  it('closes on a click outside', () => {
    render(<NavDropdown group={ADMIN} />);
    fireEvent.click(toggle());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Analytics')).toBeNull();
  });

  it('closes after following one of its links', () => {
    render(<NavDropdown group={ADMIN} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByText('Analytics'));
    expect(screen.queryByText('Analytics')).toBeNull();
  });
});
