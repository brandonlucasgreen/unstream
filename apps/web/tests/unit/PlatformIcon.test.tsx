// @vitest-environment jsdom
// UNS-220: Venmo and PayPal render through the Simple Icons SVG map instead of falling back
// to emoji like every other branded platform in PlatformIcon.tsx.
// UNS-232: Liberapay and Wikipedia join them — both carry distinctive brand marks (🤝/📖 do not).
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PlatformIcon, SIMPLE_ICON_PATHS } from 'src/components/PlatformIcon';
import { sources } from 'src/services/sources';

describe('branded platforms have Simple Icons paths (UNS-220)', () => {
  it.each(['venmo', 'paypal'] as const)('%s has an entry in SIMPLE_ICON_PATHS', (id) => {
    expect(SIMPLE_ICON_PATHS[id]).toBeTruthy();
    expect(SIMPLE_ICON_PATHS[id]).toMatch(/^M/);
  });

  it.each(['venmo', 'paypal'] as const)('%s renders an svg, not the emoji fallback', (id) => {
    const source = sources[id];
    const { container } = render(
      <PlatformIcon sourceId={id} color={source.color} emoji={source.icon} />,
    );
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect((svg?.querySelector('path')?.getAttribute('d') ?? '').length).toBeGreaterThan(50);
    expect(container.textContent).not.toContain('💵');
    expect(container.textContent).not.toContain('🅿️');
  });

  it('an unmapped platform still falls back to emoji', () => {
    const { container } = render(<PlatformIcon sourceId="bandwagon" color="#000" emoji="🚐" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('🚐');
  });
});

describe('Liberapay and Wikipedia use their Simple Icons marks (UNS-232)', () => {
  it.each(['liberapay', 'wikipedia'] as const)('%s has an entry in SIMPLE_ICON_PATHS', (id) => {
    expect(SIMPLE_ICON_PATHS[id]).toBeTruthy();
    expect(SIMPLE_ICON_PATHS[id]).toMatch(/^M/);
  });

  it.each(['liberapay', 'wikipedia'] as const)('%s renders an svg, not the emoji fallback', (id) => {
    const source = sources[id];
    const { container } = render(
      <PlatformIcon sourceId={id} color={source.color} emoji={source.icon} />,
    );
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect((svg?.querySelector('path')?.getAttribute('d') ?? '').length).toBeGreaterThan(50);
    expect(container.textContent).not.toContain('🤝');
    expect(container.textContent).not.toContain('📖');
  });

  it('renders the registry brand colors (liberapay yellow, wikipedia gray)', () => {
    const { container: lp } = render(
      <PlatformIcon sourceId="liberapay" color={sources.liberapay.color} emoji={sources.liberapay.icon} />,
    );
    expect(lp.querySelector('svg')?.getAttribute('fill')).toBe('#F6C915');

    const { container: wp } = render(
      <PlatformIcon sourceId="wikipedia" color={sources.wikipedia.color} emoji={sources.wikipedia.icon} />,
    );
    expect(wp.querySelector('svg')?.getAttribute('fill')).toBe('#636466');
  });
});