// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Skeleton, SkeletonText, SkeletonScreen, EqualizerBars } from 'src/components/Skeleton';

describe('Skeleton primitives', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a shimmer block that keeps the caller class names', () => {
    const { container } = render(<Skeleton className="h-4 w-20" />);
    const block = container.firstElementChild!;
    expect(block.className).toContain('skeleton');
    expect(block.className).toContain('h-4');
  });

  it('renders one line per requested line, with a short last line', () => {
    const { container } = render(<SkeletonText lines={3} />);
    const lines = container.querySelectorAll('.skeleton');
    expect(lines).toHaveLength(3);
    expect(lines[2].className).toContain('w-2/3');
  });

  it('hides the equalizer bars from assistive tech', () => {
    const { container } = render(<EqualizerBars />);
    expect(container.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('SkeletonScreen', () => {
  afterEach(() => {
    cleanup();
  });

  it('announces the loading label and hides the placeholder shapes', () => {
    const { container } = render(
      <SkeletonScreen label="Loading your dashboard">
        <Skeleton className="h-4" />
      </SkeletonScreen>
    );

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Loading your dashboard')).toBeTruthy();
    expect(container.querySelector('[aria-hidden="true"] .skeleton')).toBeTruthy();
  });
});
