// @vitest-environment jsdom
// UNS-220: Venmo and PayPal render through the Simple Icons SVG map instead of falling back
// to emoji like every other branded platform in PlatformIcon.tsx.
// UNS-232: Liberapay and Wikipedia join them — both carry distinctive brand marks (🤝/📖 do not).
// UNS-232 follow-up: Ampwall too, from its published brand kit; its knob mark needs
// fill-rule=evenodd, so map entries are { d, fillRule? } objects rather than bare paths.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PlatformIcon, SIMPLE_ICON_PATHS } from 'src/components/PlatformIcon';
import { sources } from 'src/services/sources';

describe('Bandcamp uses its Simple Icons mark (UNS-234)', () => {
  it('has an entry in SIMPLE_ICON_PATHS (the diamond, restored after #646 dropped it)', () => {
    expect(SIMPLE_ICON_PATHS.bandcamp?.d).toBeTruthy();
    expect(SIMPLE_ICON_PATHS.bandcamp?.d).toMatch(/^M/);
  });

  it('renders an svg, not the 🎵 emoji fallback', () => {
    const source = sources.bandcamp;
    const { container } = render(
      <PlatformIcon sourceId="bandcamp" color={source.color} emoji={source.icon} />,
    );
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect((svg?.querySelector('path')?.getAttribute('d') ?? '').length).toBeGreaterThan(10);
    expect(container.textContent).not.toContain('🎵');
  });

  it('renders the registry brand color', () => {
    const { container } = render(
      <PlatformIcon sourceId="bandcamp" color={sources.bandcamp.color} emoji={sources.bandcamp.icon} />,
    );
    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('#1da0c3');
  });
});

describe('branded platforms have Simple Icons paths (UNS-220)', () => {
  it.each(['venmo', 'paypal', 'cashapp', 'bigcartel'] as const)('%s has an entry in SIMPLE_ICON_PATHS', (id) => {
    expect(SIMPLE_ICON_PATHS[id]?.d).toBeTruthy();
    expect(SIMPLE_ICON_PATHS[id]?.d).toMatch(/^M/);
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
    expect(SIMPLE_ICON_PATHS[id]?.d).toBeTruthy();
    expect(SIMPLE_ICON_PATHS[id]?.d).toMatch(/^M/);
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

describe('Ampwall uses its published brand mark (UNS-232)', () => {
  it('has an entry sourced from the brand kit, with the knob notch carved via evenodd', () => {
    expect(SIMPLE_ICON_PATHS.ampwall?.d).toMatch(/^M/);
    // The kit's mark ships two paths; normalized to one d with three subpaths.
    expect((SIMPLE_ICON_PATHS.ampwall?.d.match(/M/g) ?? []).length).toBe(3);
    expect(SIMPLE_ICON_PATHS.ampwall?.fillRule).toBe('evenodd');
  });

  it('renders an svg with fill-rule=evenodd applied, not the 🔊 emoji fallback', () => {
    const source = sources.ampwall;
    const { container } = render(<PlatformIcon sourceId="ampwall" color={source.color} emoji={source.icon} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    const path = svg?.querySelector('path');
    expect(path?.getAttribute('fill-rule')).toBe('evenodd');
    expect(path?.getAttribute('clip-rule')).toBe('evenodd');
    expect(container.textContent).not.toContain('🔊');
  });

  it('renders the registry brand color', () => {
    const { container } = render(
      <PlatformIcon sourceId="ampwall" color={sources.ampwall.color} emoji={sources.ampwall.icon} />,
    );
    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('#1E1E24');
  });
});