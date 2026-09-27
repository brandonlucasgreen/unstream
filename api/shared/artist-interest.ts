// "I'd tip them" and Play my city: the rules every renderer of the counts shares
// (docs/specs/artist-patronage-spec.md §3.5, §3.6). Plain TypeScript with no imports so the Deno
// edge functions can use it too (api/edge/artist-page-static.ts).

/**
 * A count is shown publicly only once it reaches this, so "Most wanted in: Tiny Town (1)" can't
 * point at one person. The artist's own dashboard sees every count.
 */
export const PUBLIC_INTEREST_THRESHOLD = 3;

/** Cities shown on the public artist page and result cards. */
export const PUBLIC_CITY_LIMIT = 5;

export const MAX_CITY_LENGTH = 100;

export interface CityCount {
  label: string;
  count: number;
}

export interface InterestCounts {
  /** Fans who'd tip this artist. 0 when below the threshold the counts were read with. */
  tipCount: number;
  /** Most-wanted cities, highest first, each at or above that threshold. */
  cities: CityCount[];
}

/**
 * Trim and collapse whitespace in what a fan typed. Returns null for anything that isn't a
 * usable city: empty, too long, or containing characters no place name needs (control
 * characters, angle brackets), which keeps the label safe to echo back even before escaping.
 */
export function cleanCityLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (label.length === 0 || label.length > MAX_CITY_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(label)) return null;
  return label;
}

/**
 * The grouping key for a city: lowercased, with trailing punctuation dropped, so "Boston",
 * "boston " and "Boston." count together. Deliberately no smarter than that — "Boston, MA" and
 * "Boston" stay apart, and the input's suggestions (get_city_suggestions) are what converge them.
 */
export function cityKey(label: string): string {
  return label.toLowerCase().replace(/[.,;:!\s]+$/u, '').trim();
}

/** Shape one row of get_artist_interest_counts, tolerating a malformed `cities` value. */
export function parseInterestRow(row: { tip_count?: unknown; cities?: unknown }): InterestCounts {
  const tipCount = typeof row.tip_count === 'number' && row.tip_count > 0 ? row.tip_count : 0;
  const cities: CityCount[] = [];
  if (Array.isArray(row.cities)) {
    for (const c of row.cities) {
      if (c && typeof c.label === 'string' && typeof c.count === 'number') {
        cities.push({ label: c.label, count: c.count });
      }
    }
  }
  return { tipCount, cities };
}

/** True when there's nothing worth rendering. */
export function isEmptyInterest(counts: InterestCounts | null | undefined): boolean {
  return !counts || (counts.tipCount === 0 && counts.cities.length === 0);
}

/** "Boston (12), Leeds (5)" */
export function formatCityCounts(cities: CityCount[]): string {
  return cities.map(c => `${c.label} (${c.count})`).join(', ');
}
