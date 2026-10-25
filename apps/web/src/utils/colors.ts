/**
 * Color utilities for SourceBadge and other components that need
 * theme-aware brand color rendering.
 *
 * Brand colors are provided as hex values. Many are too dark (e.g. EVEN #000000,
 * Ampwall #1E1E24) or too bright (e.g. Beatport #01FF95, Subvert #D9DBDD) to work
 * as badge text in both light and dark modes.
 *
 * We classify colors into three bands based on relative luminance:
 *   - Dark:   luminance < 0.15  → use theme-aware text color, tinted background
 *   - Medium: luminance 0.15–0.7 → use brand color as text, brand color tint as bg
 *   - Light:  luminance > 0.7   → use darkened variant for text, stronger tint for bg
 *
 * Callers that know the active theme pass it and get a text color fitted — against
 * the badge's own tinted background composited over the card surface, not the raw
 * brand color — until it clears WCAG AA (4.5:1). Raw brand colors fail that on one
 * theme or the other (Beatport ~2.4:1 in dark, Bandcamp ~2.7:1 in light; audit
 * 2026-10-25 #8). The fit is deterministic, and color-contrast.test.ts runs it
 * across the whole platform registry for both themes.
 */

export type ThemeName = 'dark' | 'light';

/** The card surface badges and chips render on (`bg-bg-card` in index.css). */
export const BADGE_BACKDROP: Record<ThemeName, string> = {
  dark: '#1a1a1a',
  light: '#ffffff',
};

/** Mirrors `--badge-dark-text` in index.css for each theme; kept in sync and
 * pinned by color-contrast.test.ts. */
export const BADGE_FALLBACK_TEXT: Record<ThemeName, string> = {
  dark: '#999999',
  light: '#333333',
};

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Expand #abc → #aabbcc so 3-digit registry colors compose safely. */
export function normalizeHexColor(hex: string): string {
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return '#' + hex.slice(1).split('').map(c => c + c).join('');
  }
  return hex;
}

/** Append an alpha channel to a brand color: withAlpha('#629aa9', '30') → '#629aa930'. */
export function withAlpha(hex: string, alphaHex: string): string {
  return `${normalizeHexColor(hex)}${alphaHex}`;
}

function parseHex(hex: string): Rgba {
  const digits = normalizeHexColor(hex).slice(1);
  return {
    r: parseInt(digits.slice(0, 2), 16) / 255,
    g: parseInt(digits.slice(2, 4), 16) / 255,
    b: parseInt(digits.slice(4, 6), 16) / 255,
    a: digits.length >= 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
  };
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return '#' + [r, g, b]
    .map(c => Math.round(c * 255).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Alpha-composite a (possibly translucent) color over an opaque one — sRGB
 * channel blending, exactly how the browser renders `${hex}${alpha}` over a
 * card. Compose innermost-first for stacked translucent layers.
 */
export function compositeOver(top: string, bottom: string): string {
  const t = parseHex(top);
  const b = parseHex(bottom);
  return toHex({
    r: t.r * t.a + b.r * (1 - t.a),
    g: t.g * t.a + b.g * (1 - t.a),
    b: t.b * t.a + b.b * (1 - t.a),
  });
}

/**
 * Calculate relative luminance of a hex color per WCAG 2.0
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const [rs, gs, bs] = [r, g, b].map(c =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG contrast ratio between two opaque colors. */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Mix a color toward another by the given amount (0 = unchanged, 1 = target). */
function mixToward(hex: string, target: string, amount: number): string {
  const c = parseHex(hex);
  const t = parseHex(target);
  return toHex({
    r: c.r + (t.r - c.r) * amount,
    g: c.g + (t.g - c.g) * amount,
    b: c.b + (t.b - c.b) * amount,
  });
}

/**
 * Nudge a text color away from its backdrop until it meets `target` contrast.
 * The backdrop is the color the browser will actually paint behind the text
 * (a composited tint), not the raw brand color. The direction is whichever
 * side of the backdrop's luminance the text starts on — unless that side can't
 * reach the target at all (black text on a near-black backdrop, say), in which
 * case it crosses over to the other extreme.
 */
export function fitTextColor(text: string, backdrop: string, target = 4.5): string {
  const textLum = relativeLuminance(text);
  const bgLum = relativeLuminance(backdrop);
  const startsLight = textLum >= bgLum;
  const lighten = startsLight
    ? (bgLum + 0.05) * target - 0.05 <= 1 // the light side can reach the target
    : (bgLum + 0.05) / target - 0.05 < 0; // the dark side can't, so cross over
  const original = normalizeHexColor(text);
  for (let step = 0; step <= 20; step++) {
    const candidate = step === 0
      ? original
      : mixToward(original, lighten ? '#ffffff' : '#000000', step / 20);
    if (contrastRatio(candidate, backdrop) >= target) return candidate;
  }
  return lighten ? '#ffffff' : '#000000';
}

export type ColorBand = 'dark' | 'medium' | 'light';

export function colorBand(hex: string): ColorBand {
  const lum = relativeLuminance(hex);
  if (lum < 0.15) return 'dark';
  if (lum > 0.7) return 'light';
  return 'medium';
}

/** Background tint strength per band — unchanged from the original badge look. */
const TINT_ALPHA: Record<ColorBand, string> = {
  dark: '25',
  medium: '20',
  light: '35',
};

/**
 * Returns CSS color values for a source badge.
 *
 * - Without a theme (the homepage source pills), the legacy rendering is kept:
 *   the fallback text rides the theme-adaptive `--badge-dark-text` CSS var, and
 *   light brands are darkened by a fixed ratio.
 * - With a theme, the text color is fitted against the badge's tint composited
 *   over that theme's card surface until it clears WCAG AA.
 */
export function badgeColors(hex: string, theme?: ThemeName): { textColor: string; bgColor: string } {
  const color = normalizeHexColor(hex);
  const band = colorBand(color);
  const bgColor = withAlpha(color, TINT_ALPHA[band]);

  if (!theme) {
    switch (band) {
      case 'dark':
        // Too dark for direct use — use theme-aware text, subtle brand bg tint
        return { textColor: 'var(--badge-dark-text)', bgColor };
      case 'light':
        // Too light for direct use — darken for text, use moderate bg tint
        return { textColor: darkenHex(color, 0.45), bgColor };
      default:
        // Brand color works as-is for both text and bg tint
        return { textColor: color, bgColor };
    }
  }

  const backdrop = compositeOver(bgColor, BADGE_BACKDROP[theme]);
  const start = band === 'dark'
    ? BADGE_FALLBACK_TEXT[theme]
    : band === 'light' && theme === 'light'
      ? darkenHex(color, 0.45)
      : color;
  return { textColor: fitTextColor(start, backdrop), bgColor };
}

/**
 * Darken a hex color by mixing it with black at the given ratio (0 = no change, 1 = black)
 */
function darkenHex(hex: string, ratio: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.round(r * (1 - ratio));
  const dg = Math.round(g * (1 - ratio));
  const db = Math.round(b * (1 - ratio));
  return `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`;
}
