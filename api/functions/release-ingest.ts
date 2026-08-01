// Turning a fetched Bandcamp /music page into release rows.
//
// The mapping is pure and lives here; the fetching and writing live in
// catalog-artist-background.ts and db.ts. Same split as search-parsers/search-utils versus
// search-sources, and for the same reason: this is the part with decisions in it, so it
// should be testable without a network or a database.

import {
  parseBandcampGridReleases,
  parseBandcampReleaseDetail,
  isBandcampChallenge,
  type BandcampDetailOffer,
  type BandcampGridRelease,
} from './search-parsers';
import {
  deriveStatus,
  mapMusicBrainzReleaseType,
  mapReleaseType,
  parseReleaseDate,
  releaseMatchKey,
  uniqueReleaseSlug,
  type DatePrecision,
  type ReleaseStatus,
  type ReleaseType,
} from './release-utils';

/** A release ready to be written, with its one known source. */
export interface IngestedRelease {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: ReleaseType;
  /** Null for Bandcamp grid ingest: dates live only on individual release pages. */
  releaseDate: null;
  datePrecision: 'unknown';
  status: 'announced' | 'released';
  artworkUrl: string | null;
  source: {
    platform: 'bandcamp';
    url: string;
    externalId: string | null;
  };
}

export type IngestOutcome =
  | { ok: true; releases: IngestedRelease[] }
  | { ok: false; reason: 'bot_challenge' | 'no_releases' };

/**
 * Map a Bandcamp `/music` page into release rows.
 *
 * `pageUrl` is the URL we actually landed on after redirects, so relative hrefs resolve
 * against the artist's real host (which may be a Bandcamp Pro custom domain).
 *
 * Two failures are reported distinctly rather than both looking like an empty catalog,
 * because conflating them is the single most repeated bug class in this codebase:
 *
 * - `bot_challenge` — Fastly served an interstitial with HTTP 200. The upstream didn't
 *   answer, so nothing may be concluded and nothing should be cached as a negative.
 * - `no_releases` — the page parsed fine and genuinely has no releases (a parked account).
 *
 * A caller that treats these the same records "this artist has no releases" when the truth
 * is "we were blocked".
 */
export function ingestBandcampGrid(html: string, pageUrl: string, now: Date = new Date()): IngestOutcome {
  if (isBandcampChallenge(html)) return { ok: false, reason: 'bot_challenge' };

  const parsed = parseBandcampGridReleases(html);
  if (parsed.length === 0) return { ok: false, reason: 'no_releases' };

  const releases: IngestedRelease[] = [];
  const takenSlugs = new Set<string>();
  const seenKeys = new Set<string>();

  for (const entry of parsed) {
    const url = resolveReleaseUrl(entry, pageUrl);
    if (!url) continue;

    const matchKey = releaseMatchKey(entry.title);
    if (!matchKey) continue; // nothing identifiable to match on

    // Within one page, the same normalized title at the same type is the same release —
    // Bandcamp occasionally lists a release twice (featured plus in-sequence).
    const dedupeKey = `${mapReleaseType(entry.type)}:${matchKey}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    // Slug uniqueness has to account for what this run has already produced, not just what
    // is already stored — two titles can slugify identically in one page.
    const slug = uniqueReleaseSlug(entry.title, takenSlugs);
    takenSlugs.add(slug);

    releases.push({
      title: entry.title,
      slug,
      matchKey,
      releaseType: mapReleaseType(entry.type),
      // The grid carries no dates at all — they exist only on individual release pages, at
      // one extra request each. Left null rather than guessed; a later pass fills them in.
      releaseDate: null,
      datePrecision: 'unknown',
      status: deriveStatus(null, false, now),
      artworkUrl: entry.artworkUrl,
      source: {
        platform: 'bandcamp',
        url,
        externalId: entry.externalId,
      },
    });
  }

  if (releases.length === 0) return { ok: false, reason: 'no_releases' };
  return { ok: true, releases };
}

// ---------------------------------------------------------------------------
// Release pages — dates, formats, prices
// ---------------------------------------------------------------------------

/** Formats `release_offers.format` accepts. */
export type OfferFormat = 'digital' | 'vinyl' | 'cassette' | 'cd' | 'book' | 'merch' | 'other';

/** States `release_offers.availability` accepts. */
export type OfferAvailability = 'available' | 'preorder' | 'sold_out' | 'unknown';

export interface IngestedOffer {
  format: OfferFormat;
  price: number | null;
  currency: string | null;
  availability: OfferAvailability;
}

/** Everything a release page adds to what the grid already gave us. */
export interface IngestedDetail {
  releaseDate: string | null;
  datePrecision: DatePrecision;
  status: ReleaseStatus;
  offers: IngestedOffer[];
}

export type DetailOutcome =
  | { ok: true; detail: IngestedDetail }
  | { ok: false; reason: 'bot_challenge' | 'unreadable' };

/**
 * Map a Bandcamp release page into the date and offers for one release.
 *
 * Same two-failure discipline as the grid ingest: a bot challenge is the upstream declining
 * to answer and must back off, while an unreadable page is a parse problem worth reporting —
 * neither may be written down as "this release has no price".
 */
export function ingestBandcampDetail(html: string, now: Date = new Date()): DetailOutcome {
  if (isBandcampChallenge(html)) return { ok: false, reason: 'bot_challenge' };

  const detail = parseBandcampReleaseDetail(html);
  if (!detail) return { ok: false, reason: 'unreadable' };

  const { date, precision } = parseReleaseDate(detail.datePublished, now);
  const offers = aggregateOffers(detail.offers);

  return {
    ok: true,
    detail: {
      releaseDate: date,
      datePrecision: precision,
      status: deriveStatus(date, offers.some(o => o.availability === 'preorder'), now),
      offers,
    },
  };
}

/**
 * Collapse a page's packages into one offer per format.
 *
 * `release_offers` is unique on `(release_source_id, format)`, and Bandcamp routinely sells
 * several packages of the same format — a standard LP and a coloured variant, a CD and a CD
 * bundled with a shirt. Rather than pick arbitrarily, keep the **cheapest** price and the
 * **most available** state across the variants, which is what "vinyl from $25, in stock"
 * honestly means. Picking the first entry instead would quote a $60 deluxe box as the price
 * of the record.
 */
function aggregateOffers(raw: BandcampDetailOffer[]): IngestedOffer[] {
  const byFormat = new Map<OfferFormat, IngestedOffer>();

  for (const offer of raw) {
    const format = mapOfferFormat(offer.format, offer.typeName);
    const availability = mapAvailability(offer.availability);
    const existing = byFormat.get(format);

    if (!existing) {
      byFormat.set(format, { format, price: offer.price, currency: offer.currency, availability });
      continue;
    }

    // A missing price loses to a real one; between two real prices the lower wins.
    if (offer.price !== null && (existing.price === null || offer.price < existing.price)) {
      existing.price = offer.price;
      existing.currency = offer.currency;
    }
    if (AVAILABILITY_RANK[availability] > AVAILABILITY_RANK[existing.availability]) {
      existing.availability = availability;
    }
  }

  return [...byFormat.values()];
}

/** Higher wins when variants of one format disagree. Something buyable beats something not. */
const AVAILABILITY_RANK: Record<OfferAvailability, number> = {
  available: 3,
  preorder: 2,
  sold_out: 1,
  unknown: 0,
};

const SCHEMA_FORMATS: Record<string, OfferFormat> = {
  digitalformat: 'digital',
  vinylformat: 'vinyl',
  cdformat: 'cd',
  cassetteformat: 'cassette',
};

/**
 * Which of our formats is this package?
 *
 * `musicReleaseFormat` is the authority where it maps cleanly. Bandcamp also sells shirts,
 * books and bundles, which arrive as formats schema.org has no music equivalent for — so
 * where the format is unrecognized we read Bandcamp's own package label instead. Anything
 * still unidentified becomes 'other' rather than being guessed into 'digital': a fan told
 * "digital $30" about a t-shirt is worse served than one told "other $30".
 */
export function mapOfferFormat(
  schemaFormat: string | null | undefined,
  typeName: string | null | undefined
): OfferFormat {
  const mapped = schemaFormat ? SCHEMA_FORMATS[schemaFormat.toLowerCase().trim()] : undefined;
  if (mapped) return mapped;

  const label = (typeName ?? '').toLowerCase();
  if (!label) return 'other';

  if (label.includes('vinyl') || label.includes(' lp')) return 'vinyl';
  if (label.includes('cassette')) return 'cassette';
  if (label.includes('compact disc') || /\bcd\b/.test(label)) return 'cd';
  if (label.includes('book') || label.includes('zine')) return 'book';
  if (label.includes('shirt') || label.includes('poster') || label.includes('merch')) return 'merch';
  if (label.includes('digital')) return 'digital';

  return 'other';
}

/**
 * schema.org availability onto ours.
 *
 * `OnlineOnly` is what Bandcamp uses for a digital download — it means buyable, not
 * restricted. An unrecognized value stays 'unknown' rather than optimistically 'available':
 * telling a fan a sold-out record is in stock is the failure that matters here.
 */
export function mapAvailability(raw: string | null | undefined): OfferAvailability {
  switch ((raw ?? '').toLowerCase().trim()) {
    case 'instock':
    case 'onlineonly':
    case 'instoreonly':
    case 'limitedavailability':
      return 'available';
    case 'preorder':
    case 'presale':
      return 'preorder';
    case 'soldout':
    case 'outofstock':
    case 'discontinued':
      return 'sold_out';
    default:
      return 'unknown';
  }
}

/**
 * Resolve a grid href, refusing anything that leaves the host we landed on.
 *
 * Same rule as the album-page fetch in check-releases: an href out of fetched markup is
 * untrusted, and a release "source" URL pointing at someone else's domain would be stored
 * and later shown to fans as a place to buy this artist's record.
 */
function resolveReleaseUrl(entry: BandcampGridRelease, pageUrl: string): string | null {
  try {
    const resolved = new URL(entry.href, pageUrl);
    if (resolved.host !== new URL(pageUrl).host) return null;
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * The `/music` URL for an artist's Bandcamp page.
 *
 * Stored links point at all sorts of depths (`/`, `/music`, `/album/x`, with query strings),
 * and the grid only exists at `/music`.
 */
export function bandcampMusicUrl(artistUrl: string): string | null {
  try {
    const u = new URL(artistUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}/music`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discogs — physical formats, editions, real selling prices, master IDs for dedup
// ---------------------------------------------------------------------------
//
// Two-tier pass, same shape as Bandcamp's grid-then-detail split, because the underlying cost
// structure is the same: `/artists/{id}/releases` is cheap and gives a whole discography in a
// couple of paginated requests, while price and format data live one request per release. The
// difference from Bandcamp is *what* the cheap pass gives us for free: `main_release`, which
// means the detail pass doesn't need a second lookup to find the release behind a master.
//
// Filtered to `role: 'Main'` and `type: 'master'` throughout — an artist's raw releases list
// can run into the thousands once every pressing, region and reissue is counted individually
// (docs/specs/unstream-releases-v1-scope.md §10 measured 3,241 for one artist), and Discogs
// masters have already done the "these forty pressings are one album" work for us.

/** One entry from `GET /artists/{id}/releases`. */
export interface DiscogsArtistReleaseEntry {
  id: number;
  type?: string;
  main_release?: number;
  title: string;
  year?: number;
  role?: string;
  format?: string;
}

/** A master release ready to become (or merge into) a catalog row. */
export interface DiscogsMasterCandidate {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: ReleaseType;
  releaseDate: string | null;
  datePrecision: DatePrecision;
  status: ReleaseStatus;
  masterId: string;
  /** The specific release Discogs treats as this master's representative pressing — the id
   *  the detail pass fetches for price and format data. */
  mainReleaseId: string;
}

/**
 * Map an artist's Discogs discography listing into master-release candidates.
 *
 * Masters lacking `main_release` are dropped rather than kept with no way to price them — a
 * master row that can never gain an offer is a dead end, and Discogs omits this field only for
 * malformed or withdrawn masters.
 */
export function ingestDiscogsMasters(
  entries: DiscogsArtistReleaseEntry[],
  now: Date = new Date()
): DiscogsMasterCandidate[] {
  const out: DiscogsMasterCandidate[] = [];
  const takenSlugs = new Set<string>();
  const seenMasters = new Set<string>();

  for (const entry of entries) {
    if (entry.role !== 'Main' || entry.type !== 'master') continue;
    if (!entry.main_release) continue;

    const masterId = String(entry.id);
    // Discogs' pagination has repeated an id across pages before; a page-boundary is not a
    // guarantee the same master won't be seen twice in one run.
    if (seenMasters.has(masterId)) continue;
    seenMasters.add(masterId);

    const matchKey = releaseMatchKey(entry.title);
    if (!matchKey) continue;

    const { date, precision } = entry.year
      ? parseReleaseDate(String(entry.year), now)
      : { date: null, precision: 'unknown' as DatePrecision };

    const slug = uniqueReleaseSlug(entry.title, takenSlugs);
    takenSlugs.add(slug);

    out.push({
      title: entry.title,
      slug,
      matchKey,
      releaseType: mapDiscogsFormatToReleaseType(entry.format, entry.title),
      releaseDate: date,
      datePrecision: precision,
      status: deriveStatus(date, false, now),
      masterId,
      mainReleaseId: String(entry.main_release),
    });
  }

  return out;
}

/**
 * Discogs' artist-releases listing carries no dedicated release-type field — only a free-text
 * format string like "Vinyl, LP, Album" or "CD, Compilation". Parsed the same defensively as
 * `mapOfferFormat`: known keywords win, anything unrecognized becomes 'other' rather than a
 * guess. Falls back to scanning the title too, since compilations and live albums often say so
 * in the format string but occasionally only in the title ("... (Live)").
 */
export function mapDiscogsFormatToReleaseType(
  format: string | null | undefined,
  title: string | null | undefined
): ReleaseType {
  const label = `${format ?? ''} ${title ?? ''}`.toLowerCase();
  if (!label.trim()) return 'other';

  if (/\bcompilation\b/.test(label)) return 'compilation';
  if (/\blive\b/.test(label)) return 'live';
  if (/\bremix/.test(label)) return 'remix';
  if (/\bep\b/.test(label)) return 'ep';
  if (/\bsingle\b/.test(label)) return 'single';
  if (/\balbum\b/.test(label)) return 'album';

  return 'other';
}

/** What `GET /releases/{id}` gives us for one master's representative pressing. */
export interface DiscogsReleaseDetailRaw {
  released?: string | null;
  year?: number | null;
  formats?: { name?: string; descriptions?: string[] }[] | null;
  num_for_sale?: number | null;
  lowest_price?: number | null;
}

export interface DiscogsReleaseDetail {
  releaseDate: string | null;
  datePrecision: DatePrecision;
  status: ReleaseStatus;
  offers: IngestedOffer[];
}

/**
 * Map one Discogs release's own page into a date and (at most one) offer.
 *
 * `num_for_sale` and `lowest_price` describe secondhand marketplace listings for the **whole
 * release**, not broken down by format — unlike Bandcamp, which prices each format on its own
 * release page. Only one offer is emitted, keyed to the release's first listed format, rather
 * than repeating the same aggregate price across every format in a multi-format pressing (a
 * CD+book bundle showing "CD $5" and "book $5" as if either were separately buyable for $5
 * would be the false-precision mistake this codebase exists to avoid).
 *
 * Zero current listings is reported as `unknown`, not `sold_out` — "sold out" implies stock
 * existed and ran out, but a release can simply have no active marketplace listings today
 * without ever having been withdrawn.
 */
export function ingestDiscogsReleaseDetail(
  raw: DiscogsReleaseDetailRaw,
  now: Date = new Date()
): DiscogsReleaseDetail {
  const dateSource = raw.released || (raw.year ? String(raw.year) : null);
  const { date, precision } = parseReleaseDate(dateSource, now);

  const offers: IngestedOffer[] = [];
  const primaryFormat = raw.formats?.[0];
  if (primaryFormat) {
    const price = typeof raw.lowest_price === 'number' ? raw.lowest_price : null;
    const availability: OfferAvailability =
      price !== null && (raw.num_for_sale ?? 0) > 0 ? 'available' : 'unknown';

    offers.push({
      format: mapDiscogsFormatName(primaryFormat.name, primaryFormat.descriptions),
      price,
      // Discogs' public (unauthenticated) release endpoint has no currency field to read;
      // its marketplace figures default to USD for requests with no `curr_abbr` override.
      currency: price !== null ? 'USD' : null,
      availability,
    });
  }

  return {
    releaseDate: date,
    datePrecision: precision,
    status: deriveStatus(date, false, now),
    offers,
  };
}

const DISCOGS_FORMAT_NAMES: Record<string, OfferFormat> = {
  vinyl: 'vinyl',
  cd: 'cd',
  'cd-r': 'cd',
  cassette: 'cassette',
  file: 'digital',
};

/** Discogs' `formats[].name` (plus its free-text descriptions) onto our offer formats. */
export function mapDiscogsFormatName(
  name: string | null | undefined,
  descriptions?: string[] | null
): OfferFormat {
  const mapped = name ? DISCOGS_FORMAT_NAMES[name.toLowerCase().trim()] : undefined;
  if (mapped) return mapped;

  const label = (descriptions ?? []).join(' ').toLowerCase();
  if (label.includes('book') || label.includes('zine')) return 'book';
  if (label.includes('shirt') || label.includes('poster') || label.includes('box set')) return 'merch';

  return 'other';
}

// ---------------------------------------------------------------------------
// MusicBrainz — release groups, MBIDs, partial dates
// ---------------------------------------------------------------------------
//
// Enrichment only: MusicBrainz never creates a release row on its own. It has no purchase
// link to offer, and a release page with no source to buy from is a worse outcome than not
// having the page at all. Its job is filling in what Bandcamp and Discogs can't give
// precisely — a release-group MBID as a hard identity anchor for future dedup, plus dates at
// whatever precision MusicBrainz actually has (year-only and month-only are common, and
// `date_precision` exists specifically so this module never has to pad one into a fabricated
// day).

/** One entry from `GET /ws/2/release-group?artist={mbid}&inc=...`. */
export interface MusicBrainzReleaseGroupRaw {
  id: string;
  title: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[] | null;
  'first-release-date'?: string | null;
}

/** An MBID-anchored enrichment for a release we may or may not already have. */
export interface MusicBrainzReleaseGroupEnrichment {
  matchKey: string;
  releaseType: ReleaseType;
  releaseDate: string | null;
  datePrecision: DatePrecision;
  mbid: string;
}

export function ingestMusicBrainzReleaseGroups(
  groups: MusicBrainzReleaseGroupRaw[],
  now: Date = new Date()
): MusicBrainzReleaseGroupEnrichment[] {
  const out: MusicBrainzReleaseGroupEnrichment[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (!group.id || seen.has(group.id)) continue;
    seen.add(group.id);

    const matchKey = releaseMatchKey(group.title);
    if (!matchKey) continue;

    const { date, precision } = parseReleaseDate(group['first-release-date'], now);

    out.push({
      matchKey,
      releaseType: mapMusicBrainzReleaseType(group['primary-type'], group['secondary-types']),
      releaseDate: date,
      datePrecision: precision,
      mbid: group.id,
    });
  }

  return out;
}
