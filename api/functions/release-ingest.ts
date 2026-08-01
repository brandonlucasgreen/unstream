// Turning a fetched Bandcamp /music page into release rows.
//
// The mapping is pure and lives here; the fetching and writing live in
// catalog-artist-background.ts and db.ts. Same split as search-parsers/search-utils versus
// search-sources, and for the same reason: this is the part with decisions in it, so it
// should be testable without a network or a database.

import { parse, type HTMLElement } from 'node-html-parser';
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

// ---------------------------------------------------------------------------
// Faircamp — self-hosted, no central API, no reliable date or price
// ---------------------------------------------------------------------------
//
// Every Faircamp instance lives on whatever domain the artist chose (their own subdomain, in
// the one example this was built against) — there is no directory or API to query, only the
// same static site a fan lands on. Verified directly against a live instance rather than
// guessed: the homepage doubles as the release list, since every release is a plain relative
// link straight off it, and there is no reliable date or price anywhere in Faircamp's own
// markup — no JSON-LD, no `<time>` tag, no `pubDate` in its own RSS feed. So unlike Bandcamp
// and Discogs, this ingest only ever produces identity and artwork. A release with no date is
// an honest "we don't know", not a guess — and this source's whole reason for existing is that
// a partial, sometimes-wrong catalog beats no catalog at all, with curation (hide/fix) as the
// backstop for whatever guess turns out wrong.

/** Ceiling on how many relative links one homepage can offer as release candidates. */
const FAIRCAMP_MAX_CANDIDATES = 30;

/** Slugs that match the release-link shape but never are one, seen or anticipated across themes. */
const FAIRCAMP_NON_RELEASE_SLUGS = new Set(['subscribe', 'about', 'support', 'contact', 'donate', 'feed', 'blog']);

export interface FaircampReleaseCandidate {
  slug: string;
  url: string;
}

/**
 * Find candidate release links on a Faircamp artist homepage.
 *
 * Faircamp's generator wraps each release in `<div class="release">`, and on a site hosting more
 * than one artist it puts that release's credited artists in a nested `<div class="release_artists">`
 * — as links of exactly the same shape as the release's own (`kl/`, `blg/`). Reading every bare
 * relative link, as this used to, therefore catalogs a multi-artist site's *artists* as records:
 * on music.kidlightbulbs.com that produced release rows called "Kid Lightbulbs" and "Brandon
 * Lucas Green". Nothing in a release page's own markup distinguishes them afterwards — both
 * render `og:title` and neither sets a useful `og:type` — so the discrimination has to happen
 * here, where the structure still says which link is which.
 *
 * Still permissive within a release block: two links point at the same release (its cover and
 * its title) and both are accepted, deduped by slug. The fallback for a page with no release
 * blocks at all keeps the old scan, minus artist credits — a markup change should cost coverage,
 * not correctness.
 */
export function ingestFaircampHomeLinks(html: string, pageUrl: string): FaircampReleaseCandidate[] {
  const out: FaircampReleaseCandidate[] = [];
  const seen = new Set<string>();

  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return out;
  }

  const root = parse(html);
  const blocks = root.querySelectorAll('div.release');
  const anchors = (blocks.length > 0 ? blocks.flatMap(b => b.querySelectorAll('a[href]')) : root.querySelectorAll('a[href]'))
    .filter(a => !isArtistCredit(a));

  for (const anchor of anchors) {
    const raw = anchor.getAttribute('href') ?? '';
    if (!/^[a-z0-9][a-z0-9-]*\/$/i.test(raw)) continue;

    const slug = raw.slice(0, -1).toLowerCase();
    if (FAIRCAMP_NON_RELEASE_SLUGS.has(slug) || seen.has(slug)) continue;
    seen.add(slug);

    let url: string;
    try {
      url = new URL(raw, base).toString();
    } catch {
      continue;
    }

    out.push({ slug, url });
    if (out.length >= FAIRCAMP_MAX_CANDIDATES) break;
  }

  return out;
}

/** Is this link one of a release's credited artists rather than the release itself? */
function isArtistCredit(anchor: HTMLElement): boolean {
  for (let node: HTMLElement | null = anchor; node; node = node.parentNode) {
    if (node.classList?.contains('release_artists')) return true;
  }
  return false;
}

export interface FaircampReleasePage {
  title: string;
  artworkUrl: string | null;
  /** Relative href of this release's purchase page, where the price lives. Null when there
   *  isn't one — a free, unlisted or code-unlocked release has no purchase page at all. */
  purchaseHref: string | null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Pull the two things a Faircamp release page reliably gives us — title and artwork — both
 * from Open Graph tags, the only markup consistent enough across themes to trust. Returns null
 * when there's no `og:title` at all, which usually means the candidate link wasn't a release
 * page (a theme's "more" or "support" page, say) rather than a parse failure worth reporting.
 */
export function ingestFaircampReleasePage(html: string): FaircampReleasePage | null {
  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
  if (!titleMatch) return null;

  const title = decodeHtmlEntities(titleMatch[1]).trim();
  if (!title) return null;

  const imageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i);
  const artworkUrl = imageMatch ? decodeHtmlEntities(imageMatch[1]).trim() || null : null;

  const purchaseMatch = html.match(/href="(purchase\/[A-Za-z0-9_-]+\/)"/);

  return { title, artworkUrl, purchaseHref: purchaseMatch ? purchaseMatch[1] : null };
}

/**
 * Read a Faircamp purchase page's price.
 *
 * Faircamp's release pages carry no price at all — no JSON-LD, no microdata, nothing — which is
 * why the catalog showed "Still gathering formats and prices" on every Faircamp release
 * indefinitely. The price lives one level down, on `{release}/purchase/{token}/`, and this
 * reads it there.
 *
 * Matched against Faircamp's own generator (`renderer/src/pages/multitrack_purchase.rs`), which
 * emits one of two shapes:
 *
 * - **A price input** for anything with a range — name-your-price ("$0 or more"), "up to $10",
 *   or "$5–20". `data-min` is the floor, and the floor is the honest figure to publish: it is
 *   what a fan can actually pay. `0` means name-your-price, which the display layer already
 *   renders as such rather than as "free".
 * - **No input at all** for a single fixed price, rendered as text. The surrounding words are
 *   localized, but the generator always writes the amount immediately before the ISO currency
 *   code, so that adjacency is what's matched rather than any English string.
 *
 * Everything Faircamp sells here is a download, so the offer is always `digital` — the page's
 * own "available formats" line lists codecs (MP3, FLAC, WAV), not physical formats.
 *
 * Returns null when no price can be read, which callers must not turn into a price of zero:
 * "we couldn't read it" and "you may pay nothing" are different claims about someone's income.
 */
export function ingestFaircampPurchasePage(html: string): IngestedOffer | null {
  const input = html.match(/<input\b[^>]*\bid="price"[^>]*>/);
  if (input) {
    const min = input[0].match(/data-min="([0-9]+(?:\.[0-9]+)?)"/);
    if (!min) return null;
    // The currency code is written immediately after the input, inside the same wrapper.
    const currency = html.slice(input.index! + input[0].length).match(/^\s*([A-Z]{3})\b/);
    return { format: 'digital', price: Number(min[1]), currency: currency ? currency[1] : null, availability: 'available' };
  }

  const fixed = stripTags(html).match(/([0-9]+(?:[.,][0-9]+)?)\s+([A-Z]{3})\b/);
  if (!fixed) return null;

  return {
    format: 'digital',
    price: Number(fixed[1].replace(',', '.')),
    currency: fixed[2],
    availability: 'available',
  };
}

/** Text content only, so a localized price line can be matched without markup in the way. */
function stripTags(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

export interface FaircampReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: ReleaseType;
  status: ReleaseStatus;
  artworkUrl: string | null;
  externalUrl: string;
}

/**
 * Combine a homepage candidate with its release page's title/artwork into something ready to
 * persist. Release type is inferred from the title alone via the same fallback
 * `mapDiscogsFormatToReleaseType` uses when Discogs' own format string doesn't say — Faircamp
 * has no format field at all, so this is the same "read the title, otherwise 'other'" call,
 * reused rather than duplicated.
 *
 * `takenSlugs` is read, not written — the caller must add the returned slug before the next
 * call, since releases are fetched and combined one at a time here rather than as one batch
 * (each one is its own network request), unlike Bandcamp's grid.
 */
export function buildFaircampRelease(
  page: FaircampReleasePage,
  releaseUrl: string,
  takenSlugs: ReadonlySet<string>,
  now: Date = new Date()
): FaircampReleaseToPersist | null {
  const matchKey = releaseMatchKey(page.title);
  if (!matchKey) return null;

  return {
    title: page.title,
    slug: uniqueReleaseSlug(page.title, takenSlugs),
    matchKey,
    releaseType: mapDiscogsFormatToReleaseType(null, page.title),
    status: deriveStatus(null, false, now),
    artworkUrl: page.artworkUrl,
    externalUrl: releaseUrl,
  };
}

// ---------------------------------------------------------------------------
// Discovered links — a specific release, spotted on a page we fetched for another reason
// ---------------------------------------------------------------------------
//
// Some platforms (Subvert today) have no fetchable API or page of their own — but an artist's
// other pages sometimes link directly to a specific release there anyway (their own website
// linking "buy this on Subvert", say). This never fetches the target platform itself; it only
// reads links already present in markup fetched for a different reason (a Faircamp page, an
// official website), and only ever proposes a match — attaching it to an existing release
// requires an exact title match at the database layer (see `attachDiscoveredSource`), never a
// guess. A single unmatched slug becomes nothing, not a bare, metadata-less release row.

export interface DiscoveredSourceLink {
  platform: string;
  url: string;
  /** Normalized match key of the release slug, for an exact-match lookup against existing releases. */
  matchKey: string;
}

/**
 * Hosts worth checking, and the shape a link has to have to plausibly point at one specific
 * release rather than just the artist's own page there. Adding a platform here is a deliberate,
 * reviewed decision — this is not a generic link scanner.
 */
const DISCOVERED_LINK_HOSTS: { platform: string; hostSuffix: string }[] = [{ platform: 'subvert', hostSuffix: 'subvert.fm' }];

export function findDiscoveredReleaseLinks(html: string, pageUrl: string): DiscoveredSourceLink[] {
  const found: DiscoveredSourceLink[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    let url: URL;
    try {
      url = new URL(match[1], pageUrl);
    } catch {
      continue;
    }

    const host = url.hostname.toLowerCase();
    const platformEntry = DISCOVERED_LINK_HOSTS.find(p => host === p.hostSuffix || host.endsWith(`.${p.hostSuffix}`));
    if (!platformEntry) continue;

    // At least two path segments — {artist}/{release} — so the artist's own profile link
    // (just {artist}) is never mistaken for a specific release.
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) continue;

    const releaseSlug = segments[segments.length - 1];
    const matchKey = releaseMatchKey(releaseSlug.replace(/-/g, ' '));
    if (!matchKey) continue;

    const normalized = url.toString();
    const dedupeKey = `${platformEntry.platform}:${normalized}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    found.push({ platform: platformEntry.platform, url: normalized, matchKey });
  }

  return found;
}
