// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PasswordChangeForm } from '../../src/components/PasswordChangeForm';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('PasswordChangeForm', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders all three password fields', () => {
    render(<PasswordChangeForm accessToken="token123" />);

    expect(screen.getByLabelText('Current password')).not.toBeNull();
    expect(screen.getByLabelText('New password')).not.toBeNull();
    expect(screen.getByLabelText('Confirm new password')).not.toBeNull();
  });

  it('shows inline error when current password is wrong', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Current password is incorrect' }),
    });

    render(<PasswordChangeForm accessToken="token123" />);

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrongpass' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'newpass123' } });
    fireEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(screen.getByText('Current password is incorrect')).not.toBeNull();
    });
  });

  it('shows inline error when new password is too short', async () => {
    render(<PasswordChangeForm accessToken="token123" />);

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldpass123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(screen.getByText('New password must be at least 8 characters.')).not.toBeNull();
    });
  });

  it('shows inline error when passwords do not match', async () => {
    render(<PasswordChangeForm accessToken="token123" />);

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldpass123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different123' } });
    fireEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(screen.getByText('New passwords do not match.')).not.toBeNull();
    });
  });

  it('shows success message on valid password change', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    render(<PasswordChangeForm accessToken="token123" />);

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldpass123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'newpass123' } });
    fireEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(screen.getByText('Password updated.')).not.toBeNull();
    });
  });

  it('clears all fields after successful save', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    render(<PasswordChangeForm accessToken="token123" />);

    const currentInput = screen.getByLabelText('Current password') as HTMLInputElement;
    const newInput = screen.getByLabelText('New password') as HTMLInputElement;
    const confirmInput = screen.getByLabelText('Confirm new password') as HTMLInputElement;

    fireEvent.change(currentInput, { target: { value: 'oldpass123' } });
    fireEvent.change(newInput, { target: { value: 'newpass123' } });
    fireEvent.change(confirmInput, { target: { value: 'newpass123' } });
    fireEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(currentInput.value).toBe('');
      expect(newInput.value).toBe('');
      expect(confirmInput.value).toBe('');
    });
  });
});