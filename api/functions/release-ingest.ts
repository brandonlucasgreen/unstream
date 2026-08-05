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
// Jam.coop — a co-op marketplace, server-rendered, and the cheapest good source after Bandcamp
// ---------------------------------------------------------------------------
//
// Jam.coop is small (231 artists in its own directory) but it is the best-shaped source this
// feature has added since Bandcamp, for three reasons worth writing down:
//
// - **robots.txt permits everything.** Fetched and checked before a line of this was written:
//   the file contains a single comment and no `Disallow` at all — unlike Mirlo, whose genuinely
//   better API is `Disallow: /v1/` and therefore stays unbuilt (spec §10).
// - **It is entirely server-rendered.** No client-side hydration to defeat, unlike Bandwagon's
//   `/albums` listing, which returned nothing.
// - **One request per release gets everything.** Title, artwork, date, price, currency and
//   format all live on the album page — so unlike Faircamp (which needs a second purchase-page
//   request for a price, and has no date at *any* depth) a release costs exactly one fetch.
//
// Two-tier like every other source: `/artists/{slug}` lists the albums, `/artists/{slug}/albums/{album}`
// has the detail.

/** Ceiling on albums read off one artist page, before the per-run budget applies. */
const JAMCOOP_MAX_CANDIDATES = 40;

export interface JamcoopReleaseCandidate {
  /** The album's own slug, used only for dedup within a page. */
  slug: string;
  url: string;
  /** Grid artwork, kept as a fallback for an album page that somehow has no image. */
  artworkUrl: string | null;
}

/**
 * Find an artist's albums on their Jam.coop artist page.
 *
 * Matched on the **href shape** (`/artists/{artist}/albums/{album}`) rather than on the
 * surrounding markup's classes. Jam.coop is a Tailwind app, so its class strings
 * (`font-medium text-slate-600 break-words`) are presentational and would change on any
 * redesign, whereas the route shape is the app's own URL contract. The same reasoning is why
 * the album parser below reads `<h1>` and the `Released:` label instead of class selectors.
 *
 * Only albums belonging to the artist whose page this is are accepted — the page also links to
 * other artists (a "more from Jam.coop" rail, compilation credits), and cataloguing those under
 * this artist would attribute someone else's record to them.
 */
export function ingestJamcoopArtistPage(html: string, pageUrl: string): JamcoopReleaseCandidate[] {
  const out: JamcoopReleaseCandidate[] = [];
  const seen = new Set<string>();

  let base: URL;
  let artistSlug: string;
  try {
    base = new URL(pageUrl);
    const match = base.pathname.match(/^\/artists\/([^/]+)/);
    if (!match) return out;
    artistSlug = match[1].toLowerCase();
  } catch {
    return out;
  }

  const root = parse(html);

  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';

    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    // An href out of fetched markup is untrusted — same rule as `resolveReleaseUrl`.
    if (url.host !== base.host) continue;

    const match = url.pathname.match(/^\/artists\/([^/]+)\/albums\/([^/]+)\/?$/);
    if (!match) continue;
    if (match[1].toLowerCase() !== artistSlug) continue;

    const slug = match[2].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);

    const img = anchor.querySelector('img');
    out.push({
      slug,
      url: url.toString(),
      artworkUrl: img?.getAttribute('src')?.trim() || null,
    });

    if (out.length >= JAMCOOP_MAX_CANDIDATES) break;
  }

  return out;
}

export interface JamcoopAlbumPage {
  title: string;
  artworkUrl: string | null;
  releaseDate: string | null;
  datePrecision: DatePrecision;
  status: ReleaseStatus;
  /** Empty when no price could be read — never a zero standing in for "unknown". */
  offers: IngestedOffer[];
}

/**
 * Symbols Jam.coop's price line can carry, onto ISO codes.
 *
 * Deliberately only these three. A symbol that isn't here fails to match the price pattern at
 * all, so the release is stored with **no offer** rather than with a price in a guessed
 * currency: `formatMoney` defaults a null currency to USD, so publishing "¥800" as
 * `currency: null` would render it "$800" — a wrong number about someone's money on the page
 * whose whole job is being right about that. Every release sampled across the platform quoted
 * GBP (Jam.coop is a UK co-op); the other two are forward-looking, not observed.
 */
const JAMCOOP_CURRENCY_SYMBOLS: Record<string, string> = {
  '£': 'GBP',
  '€': 'EUR',
  $: 'USD',
};

/**
 * Read one Jam.coop album page: title, artwork, release date, and its single digital offer.
 *
 * Returns null when there's no `<h1>` to take a title from, which means the fetch didn't land
 * on an album page (a redirect to a listing, an error page) rather than that the album has no
 * title.
 *
 * **"£7.00 or more" is published as 7.00, not as name-your-price.** The floor is what a fan can
 * actually pay, which is the honest figure — the same call `ingestFaircampPurchasePage` makes
 * about Faircamp's `data-min`, and for the same reason. A genuine "£0.00 or more" still lands
 * as `price: 0`, which the display layer already renders as "Name your price" rather than
 * "free".
 *
 * Everything Jam.coop sells is a download ("Digital download. MP3 and FLAC"), so the offer is
 * always `digital`; there is no physical stock and therefore nothing that can be sold out.
 */
export function ingestJamcoopAlbumPage(html: string, now: Date = new Date()): JamcoopAlbumPage | null {
  const root = parse(html);

  const title = root.querySelector('h1')?.textContent?.trim();
  if (!title) return null;

  const artworkUrl = root.querySelector('img')?.getAttribute('src')?.trim() || null;

  // Jam.coop writes "<strong>Released:</strong> October 4, 2024". The label is matched rather
  // than a position, and the value handed to the shared date parser rather than parsed here.
  const dateMatch = stripTags(html).match(/Released:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/);
  const { date, precision } = parseReleaseDate(dateMatch ? dateMatch[1] : null, now);

  return {
    title,
    artworkUrl,
    releaseDate: date,
    datePrecision: precision,
    // No pre-order flag exists in Jam.coop's markup, so a future date is the only signal —
    // which is exactly what deriveStatus falls back to.
    status: deriveStatus(date, false, now),
    offers: parseJamcoopOffer(html),
  };
}

/**
 * The price line, e.g. "£3.00 or more. Digital download. MP3 and FLAC".
 *
 * Anchored on "Digital download" rather than on the amount alone: an album page also carries
 * track durations, track numbers and a description that may quote prices, and matching the
 * first currency-shaped string on the page would eventually pick one of those up.
 */
function parseJamcoopOffer(html: string): IngestedOffer[] {
  const line = stripTags(html).match(
    /([£€$])\s*([0-9]+(?:\.[0-9]{1,2})?)[^.]*\.\s*Digital download/
  );
  if (!line) return [];

  const price = Number(line[2]);
  if (!Number.isFinite(price)) return [];

  return [
    { format: 'digital', price, currency: JAMCOOP_CURRENCY_SYMBOLS[line[1]], availability: 'available' },
  ];
}

export interface JamcoopReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: ReleaseType;
  releaseDate: string | null;
  datePrecision: DatePrecision;
  status: ReleaseStatus;
  artworkUrl: string | null;
  externalUrl: string;
  offers: IngestedOffer[];
}

/**
 * Combine an album page with its candidate link into something ready to persist.
 *
 * Release type comes from the title alone, via the same fallback Faircamp uses — Jam.coop files
 * everything under `/albums/` regardless of length, so the route says nothing about type. A
 * track count was considered and rejected: a one-track release is as likely to be a long-form
 * ambient album as a single, and 'other' is an honest "we don't know" where a guess would be a
 * claim.
 *
 * `takenSlugs` is read, not written — the caller adds each returned slug before the next call,
 * since albums are fetched one at a time rather than as one batch.
 */
export function buildJamcoopRelease(
  page: JamcoopAlbumPage,
  candidate: JamcoopReleaseCandidate,
  takenSlugs: ReadonlySet<string>
): JamcoopReleaseToPersist | null {
  const matchKey = releaseMatchKey(page.title);
  if (!matchKey) return null;

  return {
    title: page.title,
    slug: uniqueReleaseSlug(page.title, takenSlugs),
    matchKey,
    releaseType: mapDiscogsFormatToReleaseType(null, page.title),
    releaseDate: page.releaseDate,
    datePrecision: page.datePrecision,
    status: page.status,
    artworkUrl: page.artworkUrl ?? candidate.artworkUrl,
    externalUrl: candidate.url,
    offers: page.offers,
  };
}

/**
 * The `/artists/{slug}` URL for a stored Jam.coop link.
 *
 * Stored links come from the directory scrape in `search-sources.ts`, which already produces
 * this shape — but a claimed artist can save any URL to their profile, so a link pointing at an
 * album or at the bare host is normalized back to the artist page rather than fetched as-is.
 */
export function jamcoopArtistUrl(storedUrl: string): string | null {
  try {
    const u = new URL(storedUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

    const match = u.pathname.match(/^\/artists\/([^/]+)/);
    if (!match) return null;

    return `${u.origin}/artists/${match[1]}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mirlo — the REST API: one request per artist for the whole discography *and* its prices
// ---------------------------------------------------------------------------
//
// `GET https://api.mirlo.space/v1/artists/{slug}` returns the artist with `trackGroups[]`
// embedded, so a Mirlo artist costs **one** request — no detail pass at all, where Bandcamp and
// Jam.coop each need 1+N. It is the cheapest and richest release source in the codebase.
//
// Mirlo's robots.txt carries `Disallow: /v1/` under a hand-written "# Disallow crawling the API"
// comment. We poll it anyway because Mirlo granted Unstream permission directly (2026-08-05) and
// issued an API key. That permission, not the key, is what makes this allowed: verified live the
// same day, the endpoint returns byte-identical responses with the key, with a bearer token, and
// with no auth at all. The key is still sent — it identifies us, and it is what they asked us to
// use — but it gates nothing, so nothing here may assume an authenticated response differs.
//
// Everything below was verified against 209 real releases across 31 artists on 2026-08-05. The
// field-level surprises are commented where they bite; three are worth reading before editing:
// prices are integer cents with `null` distinct from `0`, `currency` casing is inconsistent, and
// `platformPercent` is deliberately ignored.

/** One `trackGroups[]` entry, as `/v1/artists/{slug}` actually returns it. */
export interface MirloTrackGroupRaw {
  title?: string | null;
  urlSlug?: string | null;
  type?: string | null;
  releaseDate?: string | null;
  minPrice?: number | null;
  currency?: string | null;
  isPreorder?: boolean | null;
  isPublic?: boolean | null;
  hideFromSearch?: boolean | null;
  isGettable?: boolean | null;
  deletedAt?: string | null;
  cover?: { sizes?: Record<string, string> | null } | null;
}

export interface MirloReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: ReleaseType;
  releaseDate: string | null;
  datePrecision: DatePrecision;
  status: ReleaseStatus;
  artworkUrl: string | null;
  externalUrl: string;
  offers: IngestedOffer[];
}

/**
 * Which `cover.sizes` key to store.
 *
 * `cover.url` is an array of opaque size-suffixed **ids**, not URLs — using it would store
 * `"<uuid>-x600"` as an image src. `cover.sizes` is the parallel map of real CDN URLs.
 */
const MIRLO_COVER_SIZE = '600';

/** The `mi-temp-slug-` prefix Mirlo gives an unpublished draft's auto-generated slug. */
const MIRLO_DRAFT_SLUG_PREFIX = 'mi-temp-slug-';

/**
 * Read one artist's `/v1/artists/{slug}` response into rows ready to persist.
 *
 * Returns **null** when the body isn't a Mirlo artist document at all — an error envelope, a
 * challenge page, a redirect's HTML. That is the "never cache uncertainty" rule applied at the
 * parse boundary: an unrecognized body must not reduce to an empty list, because an empty list
 * is indistinguishable from "this artist has released nothing" and would be recorded as a
 * perfectly ordinary success. An artist who genuinely has no releases still returns `[]`.
 */
export function ingestMirloArtist(
  body: unknown,
  artistSlug: string,
  now: Date = new Date()
): MirloReleaseToPersist[] | null {
  if (!body || typeof body !== 'object') return null;

  // `/v1/artists/{slug}` wraps in `result` (singular). The search endpoint uses `results`
  // (plural) and is a different shape entirely — don't accept it here by accident.
  const result = (body as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return null;

  const artist = result as { urlSlug?: unknown; trackGroups?: unknown };

  // The document must be the artist we asked for. A redirect that landed on someone else's
  // profile would otherwise file their records under this artist.
  if (typeof artist.urlSlug !== 'string' || artist.urlSlug.toLowerCase() !== artistSlug.toLowerCase()) {
    return null;
  }
  if (!Array.isArray(artist.trackGroups)) return null;

  const out: MirloReleaseToPersist[] = [];
  const takenSlugs = new Set<string>();

  for (const node of artist.trackGroups) {
    const release = buildMirloRelease(node as MirloTrackGroupRaw, artistSlug, takenSlugs, now);
    if (!release) continue;
    takenSlugs.add(release.slug);
    out.push(release);
  }

  return out;
}

/**
 * Turn one `trackGroups[]` entry into a persistable row, or null to skip it.
 *
 * Skipped: anything the artist has hidden (`isPublic: false`, `hideFromSearch: true`,
 * `deletedAt` set) — those are deliberate settings and ingesting past them is a trust violation
 * — and **drafts**, which need their own rule. A draft carries an empty `title` and a
 * `mi-temp-slug-…` slug while still reporting `isPublic: true`, `hideFromSearch: false` and
 * `isGettable: true`, so the visibility flags do not catch it. Both draft shapes were live on
 * 2026-08-05 (`mi-temp-slug-new-album-0` and `mi-temp-slug-new-album-<uuid>`), so the prefix is
 * matched rather than the uuid suffix.
 */
export function buildMirloRelease(
  raw: MirloTrackGroupRaw,
  artistSlug: string,
  takenSlugs: ReadonlySet<string>,
  now: Date = new Date()
): MirloReleaseToPersist | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.isPublic === false || raw.hideFromSearch === true || raw.deletedAt) return null;

  const urlSlug = typeof raw.urlSlug === 'string' ? raw.urlSlug.trim() : '';
  if (!urlSlug || urlSlug.startsWith(MIRLO_DRAFT_SLUG_PREFIX)) return null;

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;

  const matchKey = releaseMatchKey(title);
  if (!matchKey) return null;

  const { date, precision } = parseReleaseDate(raw.releaseDate, now);
  const isPreorder = raw.isPreorder === true;

  return {
    title,
    slug: uniqueReleaseSlug(title, takenSlugs),
    matchKey,
    // `type` is populated on only a small minority of releases (5 of 209 live), so the title is
    // the usual signal — and an effective one here, since Mirlo artists often prefix titles
    // "[Single]" / "[EP]" / "[Compilation]". `mapReleaseType` already folds 'lp' into 'album'.
    releaseType: raw.type ? mapReleaseType(raw.type) : mapDiscogsFormatToReleaseType(null, title),
    releaseDate: date,
    datePrecision: precision,
    // Mirlo publishes a real pre-order flag, so status has a true signal rather than an
    // inference from the date.
    status: deriveStatus(date, isPreorder, now),
    artworkUrl: raw.cover?.sizes?.[MIRLO_COVER_SIZE]?.trim() || null,
    externalUrl: mirloReleaseUrl(artistSlug, urlSlug),
    offers: mirloOffers(raw),
  };
}

/**
 * The single digital offer for a Mirlo release, or none.
 *
 * Three price states, and conflating any two of them would misstate an artist's own terms:
 *
 * - `minPrice: null` (56 of 209 live, always alongside `suggestedPrice: null`) — **no price
 *   configured**. Yields no offer. Not zero: `price: 0` renders as "Name your price", which
 *   would advertise terms the artist never set.
 * - `minPrice: 0` — genuinely name-your-price. Yields `price: 0`, which the display layer
 *   already renders correctly.
 * - `minPrice: N` — a real floor, in **integer cents**. `400` is $4.00.
 *
 * `isGettable: false` (3 of 209) means it isn't purchasable at all, whatever the price says, so
 * it yields no offer either.
 *
 * `platformPercent` is **deliberately unused.** It looks like a payout share and is not
 * trustworthy as one: it contradicts the artist's own `defaultPlatformFee` (one artist had
 * `defaultPlatformFee: 7` with every release at `50`), and one free release carried
 * `platformPercent: 100`, which is meaningless as a fee. None of the outliers correlated with
 * `fundraiser` or `isAllOrNothing`. Payout comes from the platform registry until Mirlo tells us
 * what this field means — a wrong number about someone's money is worse than a coarse one.
 */
function mirloOffers(raw: MirloTrackGroupRaw): IngestedOffer[] {
  if (raw.isGettable === false) return [];

  const cents = raw.minPrice;
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents < 0) return [];

  return [
    {
      format: 'digital',
      price: cents / 100,
      // Casing is inconsistent upstream — 'GBP' and 'gbp' both occur for the same currency, as
      // do 'usd' and 'USD'. Left raw, one currency would be stored as two.
      currency: typeof raw.currency === 'string' && raw.currency.trim()
        ? raw.currency.trim().toUpperCase()
        : null,
      availability: raw.isPreorder === true ? 'preorder' : 'available',
    },
  ];
}

/** Verified live 2026-08-05: `https://mirlo.space/{artistSlug}/release/{urlSlug}` returns 200. */
function mirloReleaseUrl(artistSlug: string, releaseSlug: string): string {
  return `https://mirlo.space/${encodeURIComponent(artistSlug)}/release/${encodeURIComponent(releaseSlug)}`;
}

/**
 * The Mirlo artist slug for a stored `mirlo` link, for building the API URL.
 *
 * Stored links come from search's own Mirlo lookup, but a claimed artist can save any URL to
 * their profile, so the shape is not assumed. Live `artist_links` (measured 2026-08-02) held 50
 * bare `/{slug}`, 15 with a second segment (mostly `/releases`), 1 with three, and trailing
 * slashes throughout — the first path segment is the slug in every case.
 */
export function mirloArtistSlug(storedUrl: string): string | null {
  try {
    const u = new URL(storedUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

    const host = u.hostname.toLowerCase();
    if (host !== 'mirlo.space' && !host.endsWith('.mirlo.space')) return null;

    const slug = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    if (!slug) return null;
    // Mirlo's own routes live at the same depth as artist profiles, so a link to one of these
    // would otherwise be requested as though it were an artist.
    if (MIRLO_RESERVED_SEGMENTS.has(slug)) return null;

    return slug;
  } catch {
    return null;
  }
}

const MIRLO_RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  'login', 'signup', 'password-reset', 'profile', 'widget', 'pages', 'post', 'posts',
  'releases', 'artists', 'about', 'faq', 'terms', 'privacy', 'support', 'admin', 'api',
  'v1', 'search', 'settings', 'checkout', 'cart', 'label', 'labels',
]);

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
