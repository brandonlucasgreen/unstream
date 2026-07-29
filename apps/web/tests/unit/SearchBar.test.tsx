// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SearchBar } from '../../src/components/SearchBar';

const SUGGESTIONS = {
  query: 'argent',
  suggestions: [
    { slug: 'argent', name: 'Argent', imageUrl: null },
    { slug: 'the-argent-grub', name: 'The Argent Grub', imageUrl: null },
  ],
};

describe('SearchBar typeahead', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => SUGGESTIONS,
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function typeAndSettle(value: string) {
    fireEvent.change(screen.getByRole('combobox'), { target: { value } });
    // Run the debounce timer and let the fetch promise resolve, inside act()
    // so the resulting state updates are flushed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  }

  it('shows suggestions after the debounce', async () => {
    render(<SearchBar onSearch={vi.fn()} isLoading={false} />);
    await typeAndSettle('argent');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith('/api/suggest?query=argent', expect.anything());
  });

  it('does not fetch for queries under two characters', async () => {
    render(<SearchBar onSearch={vi.fn()} isLoading={false} />);
    await typeAndSettle('a');
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picks a suggestion with arrow keys + Enter and searches it', async () => {
    const onSearch = vi.fn();
    render(<SearchBar onSearch={onSearch} isLoading={false} />);
    await typeAndSettle('argent');

    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSearch).toHaveBeenCalledWith('The Argent Grub');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picks a suggestion on mouse down', async () => {
    const onSearch = vi.fn();
    render(<SearchBar onSearch={onSearch} isLoading={false} />);
    await typeAndSettle('argent');

    fireEvent.mouseDown(screen.getByText('Argent'));
    expect(onSearch).toHaveBeenCalledWith('Argent');
  });

  it('closes the list on Escape and submits the raw query on Enter', async () => {
    const onSearch = vi.fn();
    render(<SearchBar onSearch={onSearch} isLoading={false} />);
    await typeAndSettle('argent');

    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.submit(input.closest('form')!);
    expect(onSearch).toHaveBeenCalledWith('argent');
  });
});
