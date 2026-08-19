// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PasswordChangeForm } from '../../src/components/PasswordChangeForm';
import { updatePassword } from '../../src/services/auth';

vi.mock('../../src/services/auth', () => ({
  updatePassword: vi.fn(),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockUpdatePassword = vi.mocked(updatePassword);

describe('PasswordChangeForm', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockUpdatePassword.mockReset();
    mockUpdatePassword.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    cleanup();
  });

  describe('when the account already has a password', () => {
    it('renders all three password fields', () => {
      render(<PasswordChangeForm accessToken="token123" hasPassword={true} />);

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

      render(<PasswordChangeForm accessToken="token123" hasPassword={true} />);

      fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrongpass' } });
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass123' } });
      fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'newpass123' } });
      fireEvent.click(screen.getByText('Update password'));

      await waitFor(() => {
        expect(screen.getByText('Current password is incorrect')).not.toBeNull();
      });
    });

    it('shows inline error when new password is too short', async () => {
      render(<PasswordChangeForm accessToken="token123" hasPassword={true} />);

      fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldpass123' } });
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
      fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'short' } });
      fireEvent.click(screen.getByText('Update password'));

      await waitFor(() => {
        expect(screen.getByText('New password must be at least 8 characters.')).not.toBeNull();
      });
    });

    it('shows inline error when passwords do not match', async () => {
      render(<PasswordChangeForm accessToken="token123" hasPassword={true} />);

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

      render(<PasswordChangeForm accessToken="token123" hasPassword={true} />);

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

      render(<PasswordChangeForm accessToken="token123" hasPassword={true} />);

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

    it('posts the current password to /api/me/password', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      render(<PasswordChangeForm accessToken="token123" hasPassword={true} />);

      fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldpass123' } });
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass123' } });
      fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'newpass123' } });
      fireEvent.click(screen.getByText('Update password'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/me/password');
      expect(JSON.parse(init.body)).toEqual({ current_password: 'oldpass123', new_password: 'newpass123' });
      expect(mockUpdatePassword).not.toHaveBeenCalled();
    });
  });

  describe('when the account has never had a password', () => {
    it('does not ask for a current password', () => {
      render(<PasswordChangeForm accessToken="token123" hasPassword={false} />);

      expect(screen.queryByLabelText('Current password')).toBeNull();
      expect(screen.getByLabelText('Password')).not.toBeNull();
      expect(screen.getByLabelText('Confirm password')).not.toBeNull();
      expect(screen.getByText('Set password')).not.toBeNull();
    });

    it('sets the password via updateUser rather than /api/me/password', async () => {
      render(<PasswordChangeForm accessToken="token123" hasPassword={false} />);

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'brandnew123' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'brandnew123' } });
      fireEvent.click(screen.getByText('Set password'));

      await waitFor(() => {
        expect(screen.getByText('Password set. You can now sign in with your email and password.')).not.toBeNull();
      });
      expect(mockUpdatePassword).toHaveBeenCalledWith('brandnew123');
      // The endpoint that demands a current password must never be called here —
      // that is the bug this mode exists to fix.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('surfaces an error returned by updateUser', async () => {
      mockUpdatePassword.mockResolvedValueOnce({ error: 'New password should be different from the old password.' });

      render(<PasswordChangeForm accessToken="token123" hasPassword={false} />);

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'brandnew123' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'brandnew123' } });
      fireEvent.click(screen.getByText('Set password'));

      await waitFor(() => {
        expect(screen.getByText('New password should be different from the old password.')).not.toBeNull();
      });
    });

    it('still validates length and confirmation before submitting', async () => {
      render(<PasswordChangeForm accessToken="token123" hasPassword={false} />);

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'short' } });
      fireEvent.click(screen.getByText('Set password'));

      await waitFor(() => {
        expect(screen.getByText('Password must be at least 8 characters.')).not.toBeNull();
      });

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'brandnew123' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'different123' } });
      fireEvent.click(screen.getByText('Set password'));

      await waitFor(() => {
        expect(screen.getByText('Passwords do not match.')).not.toBeNull();
      });

      expect(mockUpdatePassword).not.toHaveBeenCalled();
    });
  });
});
