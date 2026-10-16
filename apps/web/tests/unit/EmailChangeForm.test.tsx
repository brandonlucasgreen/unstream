// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { EmailChangeForm } from '../../src/components/EmailChangeForm';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockOnPendingChange = vi.fn();

function renderForm(overrides: { pendingEmail?: string | null } = {}) {
  return render(
    <EmailChangeForm
      accessToken="token123"
      currentEmail="old@example.com"
      pendingEmail={overrides.pendingEmail ?? null}
      onPendingChange={mockOnPendingChange}
    />,
  );
}

describe('EmailChangeForm', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockOnPendingChange.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the current email address and the new-email input', () => {
    renderForm();

    expect(screen.getByText('Signed in as')).not.toBeNull();
    expect(screen.getByText('old@example.com')).not.toBeNull();
    expect(screen.getByLabelText('New email address')).not.toBeNull();
    expect(screen.getByText('Change email')).not.toBeNull();
  });

  it('shows an inline error for an address that fails our stricter pattern without calling the API', async () => {
    // 'a@b' passes the native type="email" constraint (its regex allows no dot) so the form
    // actually submits; our EMAIL_PATTERN is stricter and rejects it before any request.
    renderForm();

    fireEvent.change(screen.getByLabelText('New email address'), { target: { value: 'a@b' } });
    fireEvent.click(screen.getByText('Change email'));

    await waitFor(() => {
      expect(screen.getByText("That email address doesn't look right. Check it and try again.")).not.toBeNull();
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects the unchanged address client-side', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('New email address'), { target: { value: 'OLD@example.com' } });
    fireEvent.click(screen.getByText('Change email'));

    await waitFor(() => {
      expect(screen.getByText('That is already your email address.')).not.toBeNull();
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('posts the new address and reports that a confirmation was sent', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ pending: true, new_email: 'new@example.com' }),
    });

    renderForm();
    fireEvent.change(screen.getByLabelText('New email address'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByText('Change email'));

    await waitFor(() => {
      expect(screen.getByText(/Confirmation sent to new@example\.com/)).not.toBeNull();
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/me/email', expect.objectContaining({ method: 'POST' }));
    const init = mockFetch.mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({ new_email: 'new@example.com' });
    expect(init.headers.Authorization).toBe('Bearer token123');

    // The parent is told so it can show the pending banner (and disable re-requests).
    expect(mockOnPendingChange).toHaveBeenCalledWith('new@example.com');
    // The input is cleared after a successful request.
    expect((screen.getByLabelText('New email address') as HTMLInputElement).value).toBe('');
  });

  it('shows the server-side error when the API rejects the change', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: 'The confirmation email could not be sent. Please try again in a moment.' }),
    });

    renderForm();
    fireEvent.change(screen.getByLabelText('New email address'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByText('Change email'));

    await waitFor(() => {
      expect(screen.getByText('The confirmation email could not be sent. Please try again in a moment.')).not.toBeNull();
    });
    expect(mockOnPendingChange).not.toHaveBeenCalled();
  });

  it('surfaces the rate-limit message on 429', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Too many requests' }),
    });

    renderForm();
    fireEvent.change(screen.getByLabelText('New email address'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByText('Change email'));

    await waitFor(() => {
      expect(screen.getByText('Too many requests. Please wait a minute and try again.')).not.toBeNull();
    });
  });

  it('shows the pending-change banner with a cancel button when a change is pending', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ cancelled: true }),
    });

    renderForm({ pendingEmail: 'pending@example.com' });

    expect(screen.getByText(/Change to/)).not.toBeNull();
    expect(screen.getByText('pending@example.com')).not.toBeNull();
    expect(screen.getByText('Cancel change')).not.toBeNull();

    fireEvent.click(screen.getByText('Cancel change'));

    await waitFor(() => {
      expect(mockOnPendingChange).toHaveBeenCalledWith(null);
    });
    expect(mockFetch).toHaveBeenCalledWith('/api/me/email', expect.objectContaining({ method: 'DELETE' }));
  });

  it('shows an error when cancelling fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Could not cancel the pending change' }),
    });

    renderForm({ pendingEmail: 'pending@example.com' });

    fireEvent.click(screen.getByText('Cancel change'));

    await waitFor(() => {
      expect(screen.getByText('Could not cancel the pending change')).not.toBeNull();
    });
    // The parent keeps showing the banner since nothing changed.
    expect(mockOnPendingChange).not.toHaveBeenCalled();
  });

  it('surfaces the rate-limit message when cancelling is throttled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Too many requests' }),
    });

    renderForm({ pendingEmail: 'pending@example.com' });

    fireEvent.click(screen.getByText('Cancel change'));

    await waitFor(() => {
      expect(screen.getByText('Too many requests. Please wait a minute and try again.')).not.toBeNull();
    });
    expect(mockOnPendingChange).not.toHaveBeenCalled();
  });

  it('clears a prior success message when a cancel fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ pending: true, new_email: 'newer@example.com' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Could not cancel the pending change' }),
      });

    renderForm({ pendingEmail: 'pending@example.com' });

    fireEvent.change(screen.getByLabelText('New email address'), { target: { value: 'newer@example.com' } });
    fireEvent.click(screen.getByText('Change email'));
    await waitFor(() => {
      expect(screen.getByText(/Confirmation sent to newer@example\.com/)).not.toBeNull();
    });

    fireEvent.click(screen.getByText('Cancel change'));
    await waitFor(() => {
      expect(screen.getByText('Could not cancel the pending change')).not.toBeNull();
    });
    // No stale "confirmation sent" line left above the failure.
    expect(screen.queryByText(/Confirmation sent to/)).toBeNull();
  });
});

export {};