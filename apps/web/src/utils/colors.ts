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
 */

/**
 * Calculate relative luminance of a hex color per WCAG 2.0
 */
export function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const [rs, gs, bs] = [r, g, b].map(c =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export type ColorBand = 'dark' | 'medium' | 'light';

export function colorBand(hex: string): ColorBand {
  const lum = relativeLuminance(hex);
  if (lum < 0.15) return 'dark';
  if (lum > 0.7) return 'light';
  return 'medium';
}

/**
 * Returns CSS color values for a source badge that work in both light and dark themes.
 *
 * - Dark brand colors (low luminance): use theme-aware text via CSS var, subtle bg tint
 * - Medium brand colors: use brand color directly, brand color at 12% for bg
 * - Light brand colors (high luminance): use darkened variant for text, stronger bg tint
 */
export function badgeColors(hex: string): { textColor: string; bgColor: string } {
  const band = colorBand(hex);
  switch (band) {
    case 'dark':
      // Too dark for direct use — use theme-aware text, subtle brand bg tint
      return {
        textColor: 'var(--badge-dark-text)',
        bgColor: `${hex}25`,
      };
    case 'light':
      // Too light for direct use — darken for text, use moderate bg tint
      return {
        textColor: darkenHex(hex, 0.45),
        bgColor: `${hex}35`,
      };
    case 'medium':
    default:
      // Brand color works as-is for both text and bg tint
      return {
        textColor: hex,
        bgColor: `${hex}20`,
      };
  }
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