// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NotFoundCard } from 'src/components/NotFoundCard';

// Mock MacAppPromo
vi.mock('src/components/MacAppPromo', () => ({
  MacAppPromo: () => <div data-testid="mac-app-promo">MacAppPromo</div>,
}));

// Mock Link from react-router-dom
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

describe('NotFoundCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the not found message', () => {
    render(<NotFoundCard slug="unknown-artist" />);
    expect(screen.getByText(/couldn't find that artist/i)).toBeTruthy();
  });

  it('shows the slug formatted as a name', () => {
    render(<NotFoundCard slug="some-artist" />);
    expect(screen.getByText(/Some Artist/)).toBeTruthy();
  });

  it('renders the link back to /artists', () => {
    render(<NotFoundCard slug="test" />);
    const link = screen.getByText('Browse artists');
    expect(link).toBeTruthy();
    expect(link.closest('a')?.getAttribute('href')).toBe('/artists');
  });

  it('renders the MacAppPromo component', () => {
    render(<NotFoundCard slug="test" />);
    expect(screen.getByTestId('mac-app-promo')).toBeTruthy();
  });

  it('renders without a slug', () => {
    render(<NotFoundCard />);
    expect(screen.getByText(/couldn't find that artist/i)).toBeTruthy();
  });
});