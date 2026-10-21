// @vitest-environment jsdom
// The /settings off switch for a private release feed.
//
// Subscribing lives under Releases on /my-collection, behind that section's "has saved somebody"
// gate. A token outlives the saved artists that justified it, so revoking it cannot sit behind the
// same gate — this is what stops a leaked /feed/f/{token} URL being unrevokable.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 'tok' } }) }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { ReleaseFeedOffSwitch } from 'src/components/ReleaseFeedOffSwitch';

const fetchMock = vi.fn();

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ReleaseFeedOffSwitch', () => {
  it('asks for nothing on mount, so it cannot mint the token it exists to destroy', () => {
    render(<ReleaseFeedOffSwitch />);

    // GET /api/me/feed-token creates a token when none exists. Probing "do you have one?" would
    // hand a credential to every visitor to /settings — which is why this offers the switch
    // without knowing, and why DELETE being idempotent is what makes that honest.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Turn off my release feed/ })).toBeTruthy();
  });

  it('confirms before breaking subscriptions, then revokes', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ revoked: true }) });

    render(<ReleaseFeedOffSwitch />);
    fireEvent.click(screen.getByRole('button', { name: /Turn off my release feed/ }));

    // Nothing has been revoked yet — the first press only asks.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Yes, break existing subscriptions/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/me/feed-token');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(await screen.findByText(/Any link you had has stopped working/)).toBeTruthy();
  });

  it('backs out without revoking', () => {
    render(<ReleaseFeedOffSwitch />);
    fireEvent.click(screen.getByRole('button', { name: /Turn off my release feed/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Turn off my release feed/ })).toBeTruthy();
  });

  it('says so when the revoke fails, rather than claiming the link is off', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    render(<ReleaseFeedOffSwitch />);
    fireEvent.click(screen.getByRole('button', { name: /Turn off my release feed/ }));
    fireEvent.click(screen.getByRole('button', { name: /Yes, break existing subscriptions/ }));

    // Telling someone a leaked link is dead when it is still live is the one wrong answer here.
    expect(await screen.findByText(/Something went wrong/)).toBeTruthy();
    expect(screen.queryByText(/has stopped working/)).toBeNull();
  });

  it('points at where the feed is actually subscribed to', () => {
    render(<ReleaseFeedOffSwitch />);
    expect(screen.getByRole('link', { name: 'My Collection' }).getAttribute('href')).toBe('/my-collection');
  });
});
