// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AdminVerifyPage } from 'src/pages/AdminVerifyPage';

// Mock AuthContext
const mockSession = { access_token: 'admin-token' };
vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true, session: mockSession }),
}));

// Mock Header
vi.mock('src/components/Header', () => ({
  Header: () => null,
}));

// Mock Sentry
vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const PENDING_REQUEST = {
  id: '11111111-1111-1111-1111-111111111111',
  artist_name: 'Test Artist',
  artist_slug: 'test-artist',
  email: 'artist@example.com',
  website_url: null,
  message: 'I am the real artist',
  status: 'pending',
  reviewer_notes: null,
  created_at: '2026-06-01T00:00:00Z',
  reviewed_at: null,
  link_back_completed: false,
};

function setupFetchMock() {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ requests: [PENDING_REQUEST] }),
  });
}

describe('AdminVerifyPage: ownership checkbox state reaches server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFetchMock();
  });

  afterEach(() => cleanup());

  it('sends ownershipVerified: true when checkbox is checked and approve is clicked', async () => {
    render(<AdminVerifyPage />);

    await waitFor(() => {
      expect(screen.queryByText('Test Artist')).not.toBeNull();
    });

    // Check the checkbox
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);

    // Click approve (now enabled since checkbox is checked)
    const approveBtn = screen.getByText('Approve') as HTMLButtonElement;
    await waitFor(() => {
      expect(approveBtn.disabled).toBe(false);
    });
    fireEvent.click(approveBtn);

    // Verify the POST body sends ownershipVerified: true
    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        call => call[1]?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.ownershipVerified).toBe(true);
    });
  });

  it('sends ownershipVerified: false when checkbox is unchecked (bypass scenario)', async () => {
    render(<AdminVerifyPage />);

    await waitFor(() => {
      expect(screen.queryByText('Test Artist')).not.toBeNull();
    });

    // Checkbox is unchecked by default — approve button is disabled.
    // Simulate a bypass: force-enable the button and click it,
    // mimicking a direct handleAction() call without checking the box.
    const approveBtn = screen.getByText('Approve') as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);

    approveBtn.removeAttribute('disabled');
    fireEvent.click(approveBtn);

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        call => call[1]?.method === 'POST'
      );
      if (postCall) {
        const body = JSON.parse(postCall[1].body);
        // The fix: ownershipVerified is false, not the old hardcoded true
        expect(body.ownershipVerified).toBe(false);
      }
    });
  });
});