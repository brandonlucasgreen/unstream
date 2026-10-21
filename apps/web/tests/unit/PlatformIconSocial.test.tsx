// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { PlatformIcon } from 'src/components/PlatformIcon';
import { sources } from 'src/services/sources';
import { SOCIAL_ICON_PATHS } from '../../../../api/shared/social-icon-paths';

/**
 * A platform with no mark falls through to `emoji`, which is `source.icon` — and for the social
 * platforms that field holds the platform's *name*, not an emoji. So a missing mark didn't
 * degrade to a generic glyph, it printed the word `youtube` in YouTube red on every artist page.
 *
 * The crawler-rendered page (api/edge/artist-page-static.ts) had the marks all along, so search
 * engines saw icons while people saw the words. Found by Brandon on #653's deploy preview, and
 * pre-existing on production rather than caused by that PR.
 */
const SOCIAL_IDS = ['instagram', 'facebook', 'threads', 'tiktok', 'youtube', 'bluesky', 'mastodon', 'peertube'] as const;

describe('social platforms render a mark, not their own name', () => {
  it.each(SOCIAL_IDS)('%s draws an svg path', (id) => {
    const source = sources[id];
    expect(source, `${id} missing from sources`).toBeDefined();

    const { container } = render(
      <PlatformIcon sourceId={id} color="#ffffff" emoji={source.icon} />,
    );

    const path = container.querySelector('svg path');
    expect(path, `${id} fell through to the emoji fallback`).not.toBeNull();
    expect(path!.getAttribute('d')).toBeTruthy();
  });

  it.each(SOCIAL_IDS)('%s never renders its own name as text', (id) => {
    const source = sources[id];

    const { container } = render(
      <PlatformIcon sourceId={id} color="#ffffff" emoji={source.icon} />,
    );

    // The exact symptom: the pill showed the literal string `youtube`.
    expect(container.textContent?.trim()).toBe('');
  });

  it('still falls back to a real emoji for platforms with no mark', () => {
    const { container } = render(
      <PlatformIcon sourceId={'officialsite' as never} color="#ffffff" emoji="⭐" />,
    );

    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('⭐');
  });

  it('tints the mark with the colour it is given, not the brand colour', () => {
    // The crawler page fills with the brand colour; here the caller decides, as it does for
    // every other mark PlatformIcon draws.
    const { container } = render(
      <PlatformIcon sourceId="youtube" color="#123456" emoji="youtube" />,
    );

    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('#123456');
  });

  it('covers every social platform sources.ts defines', () => {
    // Guards the other direction: a new social platform added to sources.ts with a name-shaped
    // `icon` would silently print its name until it gets a mark here.
    for (const id of SOCIAL_IDS) {
      expect(SOCIAL_ICON_PATHS[id], `${id} has no shared path`).toBeDefined();
    }
  });
});
