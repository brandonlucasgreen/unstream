// @vitest-environment jsdom
// useResetOnPageShow: a page restored from the back/forward cache (Back from Stripe) clears its busy
// flag. An ordinary pageshow — a fresh load — leaves state alone.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useResetOnPageShow } from 'src/hooks/useResetOnPageShow';

function pageShow(persisted: boolean) {
  const event = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(event, 'persisted', { value: persisted });
  act(() => { window.dispatchEvent(event); });
}

afterEach(cleanup);

describe('useResetOnPageShow', () => {
  it('resets when the page comes back from the back/forward cache', () => {
    const reset = vi.fn();
    renderHook(() => useResetOnPageShow(reset));
    pageShow(true);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('ignores a normal page load', () => {
    const reset = vi.fn();
    renderHook(() => useResetOnPageShow(reset));
    pageShow(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it('calls the latest callback and stops listening on unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ cb }) => useResetOnPageShow(cb), { initialProps: { cb: first } });
    rerender({ cb: second });
    pageShow(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    pageShow(true);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
