import type { NavEntry, NavGroup, NavItem } from './MobileNav';

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry;
}

/** Whether `items[index]` opens a new section, so its heading is drawn above it. */
export function startsSection(items: NavItem[], index: number): boolean {
  const section = items[index].section;
  return !!section && (index === 0 || items[index - 1].section !== section);
}
