// Which of an artist's platforms the popup shows, given it has room for only a few.
//
// The popup is where a fan is at the listening moment, and the tips demand test
// (docs/specs/artist-tips-spec.md §9 Phase 0) asks whether they click an artist's own patronage
// links from there. Cutting the list at the first N in result order could drop a Patreon or
// Ko-fi link behind a row of stores, so patronage links always keep their place and the stores
// fill the rest.
//
// The extension has no build step and can't import api/shared/platform-registry.ts, so this is a
// copy of that file's `category: 'patronage'` ids. apps/web/tests/unit/extension-popup-platforms
// .test.ts fails if the two drift.
export const PATRONAGE_SOURCE_IDS = ['patreon', 'buymeacoffee', 'kofi', 'liberapay'];

// Returns at most `limit` platforms in their original order: every patronage platform, then as
// many of the rest as still fit, earliest first.
export function pickVisiblePlatforms(platforms, limit) {
  const isPatronage = p => PATRONAGE_SOURCE_IDS.includes(p.sourceId);
  const patronageCount = platforms.filter(isPatronage).length;
  let otherSlots = Math.max(0, limit - patronageCount);
  const visible = platforms.filter(p => {
    if (isPatronage(p)) return true;
    if (otherSlots === 0) return false;
    otherSlots -= 1;
    return true;
  });
  return visible.slice(0, limit);
}
