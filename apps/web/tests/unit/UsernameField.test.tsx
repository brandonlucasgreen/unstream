// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { UsernameField } from '../../src/components/UsernameField';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('UsernameField', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders with current username populated', () => {
    render(
      <UsernameField currentUsername="kidlightbulbs" accessToken="token123" onSaved={() => {}} />
    );
    const input = screen.getByLabelText('Username') as HTMLInputElement;
    expect(input.value).toBe('kidlightbulbs');
  });

  it('renders empty when no current username', () => {
    render(
      <UsernameField currentUsername={null} accessToken="token123" onSaved={() => {}} />
    );
    const input = screen.getByLabelText('Username') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('shows inline error on duplicate username (409)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Username is already taken' }),
    });

    render(
      <UsernameField currentUsername={null} accessToken="token123" onSaved={() => {}} />
    );

    const input = screen.getByLabelText('Username');
    fireEvent.change(input, { target: { value: 'taken' } });
    fireEvent.click(screen.getByText('Save username'));

    await waitFor(() => {
      expect(screen.getByText('Username is already taken')).not.toBeNull();
    });
  });

  it('shows inline error on invalid format', async () => {
    render(
      <UsernameField currentUsername={null} accessToken="token123" onSaved={() => {}} />
    );

    const input = screen.getByLabelText('Username');
    fireEvent.change(input, { target: { value: 'AB' } });
    fireEvent.click(screen.getByText('Save username'));

    await waitFor(() => {
      expect(screen.getByText(/Username must be 3-20 characters/)).not.toBeNull();
    });
  });

  it('shows success message on valid save', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ username: 'newuser' }),
    });

    render(
      <UsernameField currentUsername={null} accessToken="token123" onSaved={() => {}} />
    );

    const input = screen.getByLabelText('Username');
    fireEvent.change(input, { target: { value: 'newuser' } });
    fireEvent.click(screen.getByText('Save username'));

    await waitFor(() => {
      expect(screen.getByText('Username saved.')).not.toBeNull();
    });
  });

  it('calls onSaved callback after successful save', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ username: 'newuser' }),
    });

    const onSaved = vi.fn();

    render(
      <UsernameField currentUsername={null} accessToken="token123" onSaved={onSaved} />
    );

    const input = screen.getByLabelText('Username');
    fireEvent.change(input, { target: { value: 'newuser' } });
    fireEvent.click(screen.getByText('Save username'));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('newuser');
    });
  });

  it('disables save button when username unchanged', () => {
    render(
      <UsernameField currentUsername="kidlightbulbs" accessToken="token123" onSaved={() => {}} />
    );
    const button = screen.getByText('Save username') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});