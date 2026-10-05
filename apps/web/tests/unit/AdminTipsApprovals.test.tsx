// @vitest-environment jsdom
// Tips approvals: a disabled Approve button says why, the server's refusal (a 409) is shown in its
// own words, and a request that never reaches the server shows an error and frees the button.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const auth = vi.hoisted(() => ({ session: { access_token: 'tok' } }));
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { AdminTipsApprovals } from 'src/components/AdminTipsApprovals';

const account = (overrides: Record<string, unknown> = {}) => ({
  artistId: '11111111-1111-4111-8111-111111111111', artistName: 'Kid Lightbulbs', artistSlug: 'kid-lightbulbs',
  claimEmail: 'kid@example.com', claimVerified: true, connectedByCurrentOwner: true, stripeAccountId: 'acct_1',
  stripe: { businessName: 'Kid Lightbulbs', country: 'US', email: 'kid@example.com' },
  state: 'awaiting_approval', chargesEnabled: true, tipsEnabled: true, approvedAt: null, feeBasisPoints: 0,
  ...overrides,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const fetchMock = vi.fn();

function listing(...accounts: unknown[]) {
  return json(200, { available: true, livemode: false, accounts });
}

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AdminTipsApprovals', () => {
  it('says why Approve is disabled', async () => {
    fetchMock.mockResolvedValue(listing(account({ claimVerified: false, chargesEnabled: false })));
    render(<AdminTipsApprovals />);
    const button = await screen.findByRole('button', { name: 'Approve tips' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Can't approve yet: the profile claim isn't verified; Stripe hasn't enabled charges yet\./)).toBeTruthy();
  });

  it('names a previous owner as the reason', async () => {
    fetchMock.mockResolvedValue(listing(account({ connectedByCurrentOwner: false })));
    render(<AdminTipsApprovals />);
    expect(await screen.findByText(/Can't approve yet: connected by a previous owner of this profile\./)).toBeTruthy();
  });

  it('gives no reason when the account can be approved', async () => {
    fetchMock.mockResolvedValue(listing(account()));
    render(<AdminTipsApprovals />);
    expect((await screen.findByRole('button', { name: 'Approve tips' })).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/Can't approve yet/)).toBeNull();
  });

  it("shows the server's refusal in its own words", async () => {
    fetchMock
      .mockResolvedValueOnce(listing(account()))
      .mockResolvedValueOnce(json(409, { error: "Stripe hasn't enabled charges on this account yet." }))
      .mockImplementation(async () => listing(account()));
    render(<AdminTipsApprovals />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve tips' }));
    expect(await screen.findByText("Stripe hasn't enabled charges on this account yet.")).toBeTruthy();
  });

  it('shows an error and frees the button when the request fails outright', async () => {
    fetchMock
      .mockResolvedValueOnce(listing(account()))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(async () => listing(account()));
    render(<AdminTipsApprovals />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve tips' }));
    expect(await screen.findByText(/Couldn't approve: the request didn't reach the server/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve tips' }).hasAttribute('disabled')).toBe(false));
  });
});
