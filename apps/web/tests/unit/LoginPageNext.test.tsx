// @vitest-environment jsdom
// /login?next=: a page that asks someone to sign in (the tip thanks page) gets them back, by password
// or by magic link, and the parameter can't send anyone off the site. With no usable next, the
// landing is whatever services/accountHome resolves — never a hardcoded path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const state = vi.hoisted(() => ({
  search: '',
  session: null as null | { user: { email: string }; access_token: string },
  navigate: vi.fn(),
  accountHome: vi.fn(async () => '/my-artists'),
}));

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => ({ session: state.session, isLoading: false }) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => state.navigate,
  useSearchParams: () => [new URLSearchParams(state.search)],
}));
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('src/components/LegalConsent', () => ({ LegalConsent: () => null }));

const signInWithMagicLink = vi.fn();
vi.mock('src/services/accountHome', () => ({
  resolveAccountHome: (...args: unknown[]) => state.accountHome(...(args as [])),
  COLLECTION_HOME: '/my-collection',
  ARTIST_HOME: '/my-artists',
}));

vi.mock('src/services/auth', () => ({
  signInWithPassword: vi.fn(),
  signInWithMagicLink: (...args: unknown[]) => signInWithMagicLink(...args),
  resetPasswordForEmail: vi.fn(),
}));

import { LoginPage } from 'src/pages/LoginPage';

const THANKS = '/tip/thanks?artist=kid-lightbulbs&session_id=cs_test_a1B2c3D4e5F6g7H8';

beforeEach(() => {
  vi.clearAllMocks();
  state.search = '';
  state.session = null;
  state.accountHome.mockResolvedValue('/my-artists');
  signInWithMagicLink.mockResolvedValue({ error: null });
});
afterEach(() => cleanup());

describe('LoginPage ?next=', () => {
  it('sends a signed-in person to next', () => {
    state.search = `?next=${encodeURIComponent(THANKS)}`;
    state.session = { user: { email: 'fan@example.com' }, access_token: 'token' };
    render(<LoginPage />);
    expect(state.navigate).toHaveBeenCalledWith(THANKS, { replace: true });
    // An explicit destination settles it outright — no profiles lookup to wait on.
    expect(state.accountHome).not.toHaveBeenCalled();
  });

  it('carries next through the magic link', async () => {
    state.search = `?next=${encodeURIComponent(THANKS)}`;
    render(<LoginPage />);
    expect(screen.getByText(/keep track of your tips/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'fan@example.com' } });
    fireEvent.click(screen.getByText('Send sign-in link to email'));
    await waitFor(() => expect(signInWithMagicLink).toHaveBeenCalledTimes(1));
    expect(signInWithMagicLink.mock.calls[0][1]).toBe(`http://localhost:3000/login?next=${encodeURIComponent(THANKS)}`);
    expect(document.body.textContent).toContain("fan@example.com. Click the link and we'll bring you back to save your tip.");
  });

  it('ignores a next that leaves the site, and lands where accountHome says', async () => {
    state.search = `?next=${encodeURIComponent('//evil.example/x')}`;
    state.session = { user: { email: 'fan@example.com' }, access_token: 'token' };
    render(<LoginPage />);
    await waitFor(() => expect(state.navigate).toHaveBeenCalledWith('/my-artists', { replace: true }));
    expect(state.navigate).not.toHaveBeenCalledWith('//evil.example/x', { replace: true });
  });

  it('lands a fan with no verified artist on their collection', async () => {
    state.session = { user: { email: 'fan@example.com' }, access_token: 'token' };
    state.accountHome.mockResolvedValue('/my-collection');
    render(<LoginPage />);
    await waitFor(() => expect(state.navigate).toHaveBeenCalledWith('/my-collection', { replace: true }));
  });

  it('keeps the plain magic link without next', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'fan@example.com' } });
    fireEvent.click(screen.getByText('Send sign-in link to email'));
    await waitFor(() => expect(signInWithMagicLink).toHaveBeenCalledTimes(1));
    expect(signInWithMagicLink.mock.calls[0][1]).toBe('http://localhost:3000/login');
  });
});
