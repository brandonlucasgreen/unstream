// Pure helpers for release entities: match keys, slugs, type mapping, date hygiene.
//
// No network, no database, no cache — everything here is a function of its arguments, so
// it's all unit-testable. Keep it that way: this module is the one every later phase of
// the Releases work depends on, and the three worst bugs in the abandoned first attempt
// (PR #336) were all in about fifteen lines of untested normalization.

import { createHash } from 'crypto';
import { normalizeAccents } from './search-utils';

// ---------------------------------------------------------------------------
// Match keys
// ---------------------------------------------------------------------------

/**
 * Normalized title used to decide whether two releases are the same one. Never displayed.
 *
 * Built on `normalizeAccents` (NFD-fold, drop combining marks) so "Björk" and "Bjork"
 * agree, but the character-class step keeps **any** Unicode letter or number rather than
 * only `[a-z0-9]`.
 *
 * That difference is the whole point. `normalizeForComparison` in search-utils strips to
 * ASCII, which turns "東京", "Привет", and "Ⅱ" into the empty string — and an empty key
 * either drops the release from the catalog or, worse, matches every other non-Latin
 * title. Stripping to ASCII would also make "Tokyo 東京" and "Tokyo 大阪" both normalize to
 * "tokyo" and merge two different records, which violates the rule this whole feature is
 * built on: under-merge, never over-merge.
 */
export function releaseMatchKey(title: string): string {
  return normalizeAccents(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/** Longest slug we'll emit, before any collision suffix. Keeps URLs and indexes sane. */
const MAX_SLUG_LENGTH = 80;

/**
 * URL segment for /a/{artist}/{slug}, derived from the title.
 *
 * Accents fold to ASCII so the slug stays typable. A title with no ASCII-safe characters
 * at all (CJK, Cyrillic, Greek) has no reasonable transliteration available here, so it
 * falls back to a content hash rather than the empty string — PR #336 emitted "" for these
 * and then skipped the release entirely, silently excluding every non-Latin title from the
 * catalog.
 */
export function releaseSlug(title: string): string {
  const base = normalizeAccents(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // trailing hyphen from the truncation above

  if (base) return base;

  const key = releaseMatchKey(title);
  // `release-` prefix keeps these recognizable as generated rather than titled.
  return key ? `release-${shortHash(key)}` : `release-${shortHash(title)}`;
}

/**
 * Deterministic short digest for disambiguating slugs.
 *
 * A real hash, not a prefix of the input: PR #336 used
 * `Buffer.from(title).toString('hex').slice(0, 6)`, which is just the first three bytes of
 * the title — so "Album Name.", "Album Name!", and "Album Name?" all produced the same
 * suffix, which is precisely the case it existed to separate.
 *
 * `createHash` from node:crypto, not `crypto.subtle`, which isn't available in Netlify
 * Functions.
 */
export function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

/**
 * Pick a slug that doesn't collide with `taken`.
 *
 * Callers must add each returned slug to `taken` before the next call — the abandoned
 * first attempt fetched existing slugs once per artist and never updated the set as it
 * inserted, so two new titles that slugified identically in the same run both got the bare
 * slug and the second silently overwrote the first.
 */
export function uniqueReleaseSlug(title: string, taken: ReadonlySet<string>): string {
  const base = releaseSlug(title);
  if (!taken.has(base)) return base;

  const withHash = `${base}-${shortHash(title)}`;
  if (!taken.has(withHash)) return withHash;

  // Same title twice under one artist (a reissue, or two sources disagreeing). Walk a
  // counter rather than returning something already in use.
  for (let n = 2; n < 100; n++) {
    const candidate = `${withHash}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Effectively unreachable; better than looping forever or returning a dup.
  return `${base}-${shortHash(`${title}:${taken.size}`)}`;
}

// ---------------------------------------------------------------------------
// Release types
// ---------------------------------------------------------------------------

export type ReleaseType = 'album' | 'ep' | 'single' | 'compilation' | 'live' | 'remix' | 'other';

const RELEASE_TYPES: ReadonlySet<string> = new Set<ReleaseType>([
  'album', 'ep', 'single', 'compilation', 'live', 'remix', 'other',
]);

/**
 * Map a source's own type string onto ours, preserving granularity.
 *
 * Matching *within* a type is the strongest dedup signal available for artists with no
 * shared identifier, so collapsing everything to album-or-single throws away the thing we
 * most need. PR #336's mapper could only ever emit 'album' or 'single' — 'ep' and
 * 'compilation' were unreachable in every code path.
 *
 * Unrecognized values become 'other' rather than being guessed into 'album': a wrong type
 * blocks a legitimate match, and 'other' at least fails honestly.
 */
export function mapReleaseType(raw: string | null | undefined): ReleaseType {
  if (!raw) return 'other';
  const s = raw.toLowerCase().trim();

  if (RELEASE_TYPES.has(s)) return s as ReleaseType;

  // Bandcamp encodes type in its item ids ("album-123", "track-456") and URL paths.
  if (s === 'track' || s.startsWith('track-')) return 'single';
  if (s.startsWith('album-')) return 'album';

  if (s === 'lp' || s === 'full-length' || s === 'fulllength') return 'album';
  if (s === 'e.p.' || s === 'e.p' || s === 'mini-album') return 'ep';
  if (s === 'compilation album' || s === 'comp' || s === 'anthology') return 'compilation';
  if (s === 'live album' || s === 'live recording') return 'live';
  if (s === 'remix album' || s === 'remixes') return 'remix';
  if (s === 'digital single' || s === '7"' || s === 'maxi-single') return 'single';

  return 'other';
}

/**
 * Map MusicBrainz's release-group typing onto ours.
 *
 * MusicBrainz splits type into one `primary-type` (Album/EP/Single/Broadcast/Other) plus zero
 * or more `secondary-types` (Compilation/Live/Remix/Soundtrack/…). Secondary types win when
 * present — a live album is more usefully typed 'live' than 'album' for dedup purposes, the
 * same reasoning `mapReleaseType` already applies to Bandcamp's own type strings.
 */
export function mapMusicBrainzReleaseType(
  primaryType: string | null | undefined,
  secondaryTypes: string[] | null | undefined
): ReleaseType {
  const secondary = new Set((secondaryTypes ?? []).map(s => s.toLowerCase()));
  if (secondary.has('compilation')) return 'compilation';
  if (secondary.has('live')) return 'live';
  if (secondary.has('remix')) return 'remix';

  switch ((primaryType ?? '').toLowerCase()) {
    case 'album': return 'album';
    case 'ep': return 'ep';
    case 'single': return 'single';
    default: return 'other';
  }
}

// ---------------------------------------------------------------------------
// Cross-source dedup — tier 3 (fuzzy, never auto-merged)
// ---------------------------------------------------------------------------

/**
 * How much of the longer key the shorter one must cover to count as "probably the same".
 *
 * Low enough to catch the motivating case — an album plus its "(Deluxe Edition)" or
 * "(Remastered)" reissue, where the suffix can be nearly as long as the original title — but
 * still high enough that a short, common word contained inside an unrelated long title (both
 * happen to have "album" somewhere) doesn't trip it.
 */
const MIN_FUZZY_MATCH_RATIO = 0.4;

/** Below this length a match key is too short for containment to mean anything. */
const MIN_FUZZY_MATCH_LENGTH = 4;

/**
 * A conservative signal that two match keys under the same release_type MIGHT be the same
 * release without being exactly equal — e.g. `carrielowell` and
 * `carrielowelldeluxeedition`.
 *
 * This is tier 3 from the spec: it never merges anything. It only flags a pair as
 * `needs_review` so a human decides. "Under-merge, never over-merge" (§4) means a false
 * positive here costs a checkbox in an admin queue; a false positive in an exact-match tier
 * would silently assert two different albums are one, which nobody would ever catch.
 *
 * Deliberately narrow: one key must fully *contain* the other, not merely overlap, and the
 * shorter key must cover most of the longer one's length — otherwise two short, unrelated
 * titles that happen to share a substring ("EP" inside a longer title's match key, say) would
 * trip it.
 */
export function isFuzzyReleaseMatch(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < MIN_FUZZY_MATCH_LENGTH) return false;
  if (!longer.includes(shorter)) return false;
  return shorter.length / longer.length >= MIN_FUZZY_MATCH_RATIO;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';

export interface ParsedReleaseDate {
  /** ISO yyyy-mm-dd, or null when there's no usable date. */
  date: string | null;
  precision: DatePrecision;
}

/** Earliest plausible release date. Matches the CHECK constraint on releases.release_date. */
const MIN_YEAR = 1900;

/**
 * How far ahead a release date may sit. Genuine announcements run well over a year out
 * (Mirlo had one dated 2027-09-07 against a 2026 today), so the bound has to be generous
 * enough not to reject real pre-orders while still catching typos.
 */
const MAX_YEARS_AHEAD = 3;

/**
 * Parse and sanity-bound a source's release date.
 *
 * The bound is not defensive programming, it's a live data problem: Mirlo currently
 * carries a release dated **2925-11-02**. Unbounded, one typo sorts to the top of every
 * chronology and lands in every calendar subscriber's feed forever.
 *
 * Partial dates are kept at the precision they arrived with rather than being padded
 * silently — MusicBrainz returns year-only and month-only dates, and rendering "1 January"
 * for a year-only date states a fact the source never gave us. The padding still happens
 * (a date column needs a full date) but `precision` records that it was our doing.
 *
 * `now` is injectable so tests don't depend on the wall clock.
 */
export function parseReleaseDate(
  raw: string | null | undefined,
  now: Date = new Date()
): ParsedReleaseDate {
  if (!raw) return { date: null, precision: 'unknown' };

  const s = String(raw).trim();
  if (!s) return { date: null, precision: 'unknown' };

  let year: number;
  let month = 1;
  let day = 1;
  let precision: DatePrecision;

  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const ym = s.match(/^(\d{4})-(\d{2})$/);
  const y = s.match(/^(\d{4})$/);

  if (ymd) {
    [year, month, day] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    precision = 'day';
  } else if (ym) {
    [year, month] = [Number(ym[1]), Number(ym[2])];
    precision = 'month';
  } else if (y) {
    year = Number(y[1]);
    precision = 'year';
  } else {
    // Formats like "December 6, 2024" and Bandcamp's "06 Dec 2024 00:00:00 GMT".
    // Parsed as UTC noon rather than via bare `new Date(s)`, which interprets a
    // date-only string as local midnight and can format back as the previous day.
    const parsed = parseTextualDate(s);
    if (!parsed) return { date: null, precision: 'unknown' };
    [year, month, day] = parsed;
    precision = 'day';
  }

  if (!isCalendarDate(year, month, day)) return { date: null, precision: 'unknown' };

  const maxYear = now.getUTCFullYear() + MAX_YEARS_AHEAD;
  if (year < MIN_YEAR || year > maxYear) return { date: null, precision: 'unknown' };

  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { date: iso, precision };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "December 6, 2024" / "6 Dec 2024 ..." -> [y, m, d]. Null when neither shape matches. */
function parseTextualDate(s: string): [number, number, number] | null {
  const monthFirst = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthFirst) {
    const m = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
    if (m) return [Number(monthFirst[3]), m, Number(monthFirst[2])];
  }

  const dayFirst = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/);
  if (dayFirst) {
    const m = MONTHS[dayFirst[2].slice(0, 3).toLowerCase()];
    if (m) return [Number(dayFirst[3]), m, Number(dayFirst[1])];
  }

  return null;
}

/** Reject 2024-02-31 and friends — Date would roll them over into March. */
function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day, 12));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type ReleaseStatus = 'announced' | 'released';

/**
 * Is this release out yet?
 *
 * Stored rather than computed per request so feeds and chronologies can filter cheaply,
 * and because a list that silently mixes future and past releases under "newest first"
 * reads as broken. An upstream pre-order flag wins over the date — Bandcamp and Mirlo both
 * expose one, and it's more reliable than comparing a possibly-imprecise date.
 *
 * Undated releases count as released: they're overwhelmingly back-catalog, and promising a
 * fan something is "coming" when we simply don't know is the worse error.
 */
export function deriveStatus(
  date: string | null,
  isPreorder: boolean = false,
  now: Date = new Date()
): ReleaseStatus {
  if (isPreorder) return 'announced';
  if (!date) return 'released';

  const today = now.toISOString().slice(0, 10);
  return date > today ? 'announced' : 'released';
}
