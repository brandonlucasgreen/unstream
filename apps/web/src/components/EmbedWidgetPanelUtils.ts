import { sources, sourceCategories } from '../services/sources';

// Which of an artist's links the embed widget can draw, and how the snippet names them. Kept out
// of EmbedWidgetPanel.tsx so that file exports only components.

export type EmbedLink = { platform: string; displayName?: string | null };

/**
 * A custom link the artist added to their page. The page stores them as other_0, other_1, ... in
 * page order (api/shared/link-dividers.ts); older rows may say just "other". widget.js draws them
 * with their own label, by the same test.
 */
export function isCustomLink(platform: string): boolean {
  return platform === 'other' || /^other_[0-9]+$/.test(platform);
}

/**
 * What the widget can draw, once each, in the order the artist's page lists them: every platform
 * in sources.ts except the category buckets (widget.js's table, which platform-logo-copies.test.ts
 * keeps true), plus each of the artist's custom links.
 */
export function embeddablePlatforms(links: EmbedLink[]): string[] {
  const ids: string[] = [];
  for (const { platform } of links) {
    const known = platform in sources && !(platform in sourceCategories) && platform !== 'other';
    if ((known || isCustomLink(platform)) && !ids.includes(platform)) ids.push(platform);
  }
  return ids;
}

export function isReordered(pageOrder: string[], embedOrder: string[]): boolean {
  return embedOrder.some((id, index) => id !== pageOrder[index]);
}

/**
 * The snippet's data-platforms. Everything in page order is "all"; everything reordered keeps a
 * trailing "*", so a platform added to the page later still appears (at the end). A subset is
 * exactly that subset, in embed order.
 */
export function platformsAttribute(
  pageOrder: string[],
  embedOrder: string[],
  excluded: Set<string>,
): string {
  const chosen = embedOrder.filter((id) => !excluded.has(id));
  if (chosen.length < pageOrder.length) return chosen.join(',');
  return isReordered(pageOrder, embedOrder) ? [...chosen, '*'].join(',') : 'all';
}
