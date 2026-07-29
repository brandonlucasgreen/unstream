// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { HeaderSearch } from '../../src/components/HeaderSearch';

const SUGGESTIONS = {
  query: 'argent',
  suggestions: [
    { slug: 'argent', name: 'Argent', imageUrl: null },
    { slug: 'the-argent-grub', name: 'The Argent Grub', imageUrl: null },
  ],
};

/** Surfaces the current URL so we can assert where a search navigated to. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderAt(initialUrl: string, props: Parameters<typeof HeaderSearch>[0] = {}) {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <HeaderSearch {...props} />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

function currentUrl() {
  return screen.getByTestId('location').textContent;
}

describe('HeaderSearch', () => {
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  }

  it('navigates to /?q= on submit, from any page', () => {
    renderAt('/guides/some-guide');
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'radiohead' } });
    fireEvent.submit(input.closest('form')!);

    expect(currentUrl()).toBe('/?q=radiohead');
  });

  it('percent-encodes the query rather than building a broken URL', () => {
    renderAt('/faq');
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'sigur rós & friends' } });
    fireEvent.submit(input.closest('form')!);

    expect(currentUrl()).toBe('/?q=sigur%20r%C3%B3s%20%26%20friends');
  });

  it('trims the query and ignores a whitespace-only submit', () => {
    renderAt('/faq');
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(currentUrl()).toBe('/faq');

    fireEvent.change(input, { target: { value: '  beach house  ' } });
    fireEvent.submit(input.closest('form')!);
    expect(currentUrl()).toBe('/?q=beach%20house');
  });

  it('seeds the input from ?q= so the header reflects the search on screen', () => {
    renderAt('/?q=beach%20house');
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('beach house');
  });

  it('picks a suggestion with arrow keys + Enter and searches it', async () => {
    renderAt('/settings');
    await typeAndSettle('argent');

    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(currentUrl()).toBe('/?q=The%20Argent%20Grub');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('uses its own option ids, so it cannot collide with the SearchBar on the dashboard', async () => {
    renderAt('/dashboard');
    await typeAndSettle('argent');

    expect(screen.getByRole('listbox').id).toBe('header-search-suggestions');
    expect(screen.getAllByRole('option')[0].id).toBe('header-search-suggestion-0');
  });

  it('closes the mobile row on submit', () => {
    const onClose = vi.fn();
    renderAt('/faq', { onClose });

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'radiohead' } });
    fireEvent.submit(input.closest('form')!);

    expect(onClose).toHaveBeenCalled();
  });

  it('closes the dropdown on the first Escape and the mobile row on the second', async () => {
    const onClose = vi.fn();
    renderAt('/faq', { onClose });
    await typeAndSettle('argent');

    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
