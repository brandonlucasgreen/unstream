import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../../../../api/shared/platform-registry';
import {
  BADGE_BACKDROP,
  BADGE_FALLBACK_TEXT,
  badgeColors,
  compositeOver,
  contrastRatio,
  fitTextColor,
  withAlpha,
} from 'src/utils/colors';

const AA = 4.5;

// index.css is the source of truth for the theme tokens — read the file so the
// numbers checked here are the ones the site actually ships.
const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
const lightStart = css.indexOf('@media (prefers-color-scheme: light)');
if (lightStart === -1) throw new Error('light theme block not found in index.css');
const darkCss = css.slice(0, lightStart);
const lightCss = css.slice(lightStart);

function token(css: string, name: string): string | undefined {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  return match?.[1];
}

// The light block only overrides what differs; everything else inherits the dark default.
function tokenFor(theme: 'dark' | 'light', name: string): string {
  const value = theme === 'light' ? (token(lightCss, name) ?? token(darkCss, name)) : token(darkCss, name);
  if (!value) throw new Error(`token --${name} not found in index.css`);
  return value;
}

describe('theme token contrast (audit 2026-10-25 #8)', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`accent foreground clears AA on the ${theme} accent fill, including the hover state`, () => {
      const fill = tokenFor(theme, 'color-accent-primary');
      const foreground = tokenFor(theme, 'color-accent-foreground');
      expect(contrastRatio(foreground, fill), `${foreground} on ${fill}`).toBeGreaterThanOrEqual(AA);
      // hover:bg-accent-primary/90 composites the fill over the page background.
      const hover = compositeOver(withAlpha(fill, 'e6'), tokenFor(theme, 'color-bg-primary'));
      expect(contrastRatio(foreground, hover), `${foreground} on hover ${hover}`).toBeGreaterThanOrEqual(AA);
    });

    it(`${theme} link token clears AA on page and card backgrounds`, () => {
      const link = tokenFor(theme, 'color-link');
      expect(contrastRatio(link, tokenFor(theme, 'color-bg-primary')), `${link} on bg-primary`).toBeGreaterThanOrEqual(AA);
      expect(contrastRatio(link, tokenFor(theme, 'color-bg-card')), `${link} on bg-card`).toBeGreaterThanOrEqual(AA);
    });

    it(`${theme} status tokens clear AA on page and card backgrounds`, () => {
      for (const name of ['color-success', 'color-warning', 'color-error']) {
        const color = tokenFor(theme, name);
        expect(contrastRatio(color, tokenFor(theme, 'color-bg-primary')), `${color} on bg-primary`).toBeGreaterThanOrEqual(AA);
        expect(contrastRatio(color, tokenFor(theme, 'color-bg-card')), `${color} on bg-card`).toBeGreaterThanOrEqual(AA);
      }
    });

    it(`${theme} muted text clears AA on cards`, () => {
      expect(contrastRatio(tokenFor(theme, 'color-text-muted'), tokenFor(theme, 'color-bg-card')))
        .toBeGreaterThanOrEqual(AA);
    });

    it(`${theme} secondary accent clears AA as text on cards`, () => {
      expect(contrastRatio(tokenFor(theme, 'color-accent-secondary'), tokenFor(theme, 'color-bg-card')))
        .toBeGreaterThanOrEqual(AA);
    });
  }

  it('keeps --badge-dark-text in index.css in sync with BADGE_FALLBACK_TEXT', () => {
    expect(token(darkCss, 'badge-dark-text')).toBe(BADGE_FALLBACK_TEXT.dark);
    expect(token(lightCss, 'badge-dark-text')).toBe(BADGE_FALLBACK_TEXT.light);
  });
});

describe('registry-wide badge contrast (audit 2026-10-25 #8)', () => {
  const platformList = Object.entries(PLATFORMS);

  it('every platform badge clears AA in both themes against its composited background', () => {
    for (const [id, platform] of platformList) {
      for (const theme of ['dark', 'light'] as const) {
        const { textColor, bgColor } = badgeColors(platform.color, theme);
        const backdrop = compositeOver(bgColor, BADGE_BACKDROP[theme]);
        expect(
          contrastRatio(textColor, backdrop),
          `${id} (${platform.color}) badge in ${theme}: ${textColor} on ${bgColor} over ${BADGE_BACKDROP[theme]}`
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('every payout chip clears AA in both themes', () => {
    for (const [id, platform] of platformList) {
      if (!platform.payoutPercent) continue;
      for (const theme of ['dark', 'light'] as const) {
        // Mirrors the chip in SourceBadge: a stronger brand tint over the badge's own tint.
        const badgeBg = badgeColors(platform.color, theme).bgColor;
        const backdrop = compositeOver(withAlpha(platform.color, '30'), compositeOver(badgeBg, BADGE_BACKDROP[theme]));
        expect(
          contrastRatio(fitTextColor(platform.color, backdrop), backdrop),
          `${id} payout chip in ${theme}`
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('the Bandcamp Friday chip clears AA in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      const badgeBg = badgeColors('#1da0c3', theme).bgColor;
      const backdrop = compositeOver('#1da0c320', compositeOver(badgeBg, BADGE_BACKDROP[theme]));
      expect(
        contrastRatio(fitTextColor('#1da0c3', backdrop), backdrop),
        `Bandcamp Friday chip in ${theme}`
      ).toBeGreaterThanOrEqual(AA);
    }
  });
});

// The tokens above only help where components use them. These are the classes they replace:
// fixed Tailwind colours that fail AA in one theme (light-theme status text at ~1.7-2.7:1, accent
// text at 3.45:1, white on an accent fill at 2.84-3.60:1). Use text-error / text-success /
// text-warning / text-link, and text-accent-foreground on bg-accent-primary.
describe('components use the contrast tokens', () => {
  const srcDir = fileURLToPath(new URL('../../src', import.meta.url));
  const files = (readdirSync(srcDir, { recursive: true }) as string[])
    .filter(f => f.endsWith('.tsx'))
    .map(f => ({ name: f, text: readFileSync(join(srcDir, f), 'utf8') }));

  it.each([
    ['text-red-400 / text-red-500', /(?<![\w-])text-red-(400|500)(?![\w/-])/],
    ['text-green-400 / text-green-500', /(?<![\w-])text-green-(400|500)(?![\w/-])/],
    ['text-yellow-400..600 / text-amber-400', /(?<![\w-])text-(yellow-(400|500|600)|amber-400)(?![\w/-])/],
    ['text-accent-primary', /(?<![\w-])text-accent-primary(?![\w/-])/],
  ])('no component uses %s', (_label, pattern) => {
    expect(files.filter(f => pattern.test(f.text)).map(f => f.name)).toEqual([]);
  });

  it('puts the accent-foreground ink, not white, on a solid accent fill', () => {
    const offenders = files.filter(f =>
      f.text.split('\n').some(line => /(?<![\w-])bg-accent-primary(?![\w/-])/.test(line) && /(?<![\w:-])text-white(?![\w/-])/.test(line))
    );
    expect(offenders.map(f => f.name)).toEqual([]);
  });
});
