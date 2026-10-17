// Page sections for claimed artist pages (UNS-221) — shared between the edge function, the API
// endpoints, and the web client, because all three render (or feed) the artist page.
//
// A claimed artist's page is an ordered list of sections. Links were already artist-orderable
// (artist_links.display_order, plus the link_dividers rules), but the page grouped them under
// two fixed headings — "Support directly" and "Follow" — with a fixed order of everything
// around them. UNS-221 replaces that with a section model:
//
//   patronage    — the first-party Tip block (when the artist takes tips) followed by the
//                  platform patronage links (Patreon, Ko-fi, Venmo, PayPal, Liberapay…).
//                  Tip always renders at the top of this section and is not artist-placed
//                  within it; the section itself is.
//   bio          — the bio paragraph.
//   featured     — the "Featured Release" embed from the edit page.
//   marketplaces — the marketplace links (Bandcamp, Mirlo, Bandwagon, Qobuz…), plus every
//                  other non-patronage, non-official, non-social link (decentralized, library,
//                  custom "other"), so a reorder can never drop a link off the page.
//   official     — official pages (official site, Wikipedia, Faircamp, Newsletter — UNS-221
//                  recategorises the last two into "official"). NOT artist-orderable: the
//                  acceptance criteria name four link groups but editable sections
//                  "bio, featured release, patronage, marketplaces, social", so this section
//                  is pinned immediately after whatever the marketplaces slot renders.
//   social       — the "Follow" links (Instagram, YouTube, Mastodon…).
//
// The artist can reorder `bio, featured, patronage, marketplaces, social` — the default
// order Brandon set after seeing it arranged (bio/featured first, patronage mid-page).
// Sections with no content are skipped by the renderer; the order only decides *sequence*.

/** Page section keys in the default display order. */
export const DEFAULT_SECTION_ORDER = [
  'bio',
  'featured',
  'patronage',
  'marketplaces',
  'social',
] as const;

export type EditableSectionKey = (typeof DEFAULT_SECTION_ORDER)[number];

/**
 * "official pages" completes the link-group list of the acceptance criteria but is
 * deliberately absent from the artist-editable order (which names exactly
 * "bio, featured release, patronage, marketplaces, social"): it renders in the
 * marketplaces slot, directly after it, wherever that lands in the artist's order.
 */
export type PageSectionKey = EditableSectionKey | 'official';

const KNOWN_KEYS: ReadonlySet<string> = new Set(DEFAULT_SECTION_ORDER);

/**
 * Which link category lands in which page section. Everything that is not patronage,
 * official or social rides in "marketplaces" so no stored link can vanish from a
 * claimed page through a recategorisation gap (library, custom "other",
 * decentralized, or any platform id we don't know).
 */
export function linkSectionForCategory(category: string | undefined): PageSectionKey {
  if (category === 'patronage') return 'patronage';
  if (category === 'official') return 'official';
  if (category === 'social') return 'social';
  return 'marketplaces';
}

/**
 * Validate the artist's saved order, as sent by the edit page and stored raw in
 * artist_profiles.section_order.
 *
 * Duplicates and unknown keys are dropped; every DEFAULT_SECTION_ORDER key the list omitted is
 * re-appended in default order, so an edit-page bug can never hide a section the artist has
 * content for — an order edit can only rearrange. Empty/absent/invalid input → null, which
 * every renderer reads as "no custom order saved".
 */
export function normalizeSectionOrder(input: unknown): PageSectionKey[] | null {
  if (!Array.isArray(input)) return null;

  const seen: PageSectionKey[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || !KNOWN_KEYS.has(raw)) continue;
    const key = raw as PageSectionKey;
    if (!seen.includes(key)) seen.push(key);
  }

  for (const key of DEFAULT_SECTION_ORDER) {
    if (!seen.includes(key)) seen.push(key);
  }

  return seen.length > 0 ? seen : null;
}

/** The order to render: the artist's stored one, or the default (bio first) when none. */
export function resolveSectionOrder(stored: unknown): PageSectionKey[] {
  return normalizeSectionOrder(stored) ?? [...DEFAULT_SECTION_ORDER];
}

/**
 * Split an ordered link list into per-section groups, preserving within-section order, and
 * translate stored divider positions (indexes into `orderedLinks`) into per-section rule
 * positions (indexes into that section's own array).
 *
 * `categoryOf` returns the platform-registry category of a link (or undefined for an unknown
 * platform) — links whose id we don't know ride in "marketplaces" with the rest of the
 * catch-all, never dropped. A stored divider that lands inside "social" with the socials in
 * their own section simply never materialises as a rule in a link section, the same way
 * mainLinkDividerIndexes drops a rule with nothing on one side.
 */
export interface LinkSectionGroup<T> {
  key: PageSectionKey;
  /** The section's links, in the artist's own order. */
  items: T[];
  /** Positions in `items` before which a horizontal divider is drawn. */
  ruleIndexes: number[];
}

export function groupLinksIntoSections<T>(
  orderedLinks: T[],
  categoryOf: (link: T) => string | undefined,
  dividerPositions: readonly number[] | null | undefined,
): LinkSectionGroup<T>[] {
  const positions = new Set(dividerPositions ?? []);
  const groups = new Map<PageSectionKey, LinkSectionGroup<T>>();

  for (const key of DEFAULT_SECTION_ORDER) {
    groups.set(key, { key, items: [], ruleIndexes: [] });
  }
  // `official` is rendered inside the marketplaces slot, not on its own row of the order —
  // but its links must still be grouped, or a Faircamp/Newsletter/Wikipedia link would
  // silently vanish from the page.
  groups.set('official', { key: 'official', items: [], ruleIndexes: [] });

  orderedLinks.forEach((link, index) => {
    const group = groups.get(linkSectionForCategory(categoryOf(link)));
    if (!group) return;
    if (positions.has(index) && group.items.length > 0) {
      group.ruleIndexes.push(group.items.length);
    }
    group.items.push(link);
  });

  // `official` after marketplaces, never dropped: an official page (Faircamp, Newsletter,
  // Wikipedia, Official Site) belongs on the artist's page even unsourced in the order.
  const ordered = [...DEFAULT_SECTION_ORDER.map((key) => groups.get(key)!), groups.get('official')!];
  return ordered.filter((g) => g.items.length > 0);
}