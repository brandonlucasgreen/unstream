// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ScreenshotCarousel } from 'src/components/ScreenshotCarousel';

// jsdom has no matchMedia; the carousel asks it about prefers-reduced-motion.
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

/** The slide currently faded in — the others sit at opacity-0 behind it. */
function visibleSlide() {
  const images = screen.getAllByRole('img', { hidden: true });
  return images.findIndex((img) => img.className.includes('opacity-100'));
}

describe('ScreenshotCarousel', () => {
  it('starts on the first slide', () => {
    render(<ScreenshotCarousel />);
    expect(visibleSlide()).toBe(0);
    expect(screen.getByText('Screenshot 1 of 5')).toBeTruthy();
  });

  it('steps forward and wraps around at the end', () => {
    render(<ScreenshotCarousel />);
    const next = screen.getByLabelText('Next screenshot');
    for (let i = 0; i < 4; i++) fireEvent.click(next);
    expect(visibleSlide()).toBe(4);
    fireEvent.click(next);
    expect(visibleSlide()).toBe(0);
  });

  it('steps backward from the first slide to the last', () => {
    render(<ScreenshotCarousel />);
    fireEvent.click(screen.getByLabelText('Previous screenshot'));
    expect(visibleSlide()).toBe(4);
  });

  it('jumps to a slide from its dot and marks it current', () => {
    render(<ScreenshotCarousel />);
    fireEvent.click(screen.getByLabelText('Show screenshot 3 of 5'));
    expect(visibleSlide()).toBe(2);
    expect(screen.getByLabelText('Show screenshot 3 of 5').getAttribute('aria-current')).toBe('true');
    expect(screen.getByLabelText('Show screenshot 1 of 5').getAttribute('aria-current')).toBe('false');
  });

  it('advances on its own until someone interacts', () => {
    render(<ScreenshotCarousel />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(visibleSlide()).toBe(1);

    // Any interaction hands control over for good.
    fireEvent.click(screen.getByLabelText('Next screenshot'));
    expect(visibleSlide()).toBe(2);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(visibleSlide()).toBe(2);
  });

  it('does not autoplay when the visitor prefers reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    render(<ScreenshotCarousel />);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(visibleSlide()).toBe(0);
  });

  it('moves with the arrow keys', () => {
    render(<ScreenshotCarousel />);
    const carousel = screen.getByRole('group');
    fireEvent.keyDown(carousel, { key: 'ArrowRight' });
    expect(visibleSlide()).toBe(1);
    fireEvent.keyDown(carousel, { key: 'ArrowLeft' });
    expect(visibleSlide()).toBe(0);
  });
});
