// Pure HTML parsing functions extracted from search-sources.ts for testability.
// These contain no I/O — they take HTML strings and return structured results.

import { parse, type HTMLElement } from 'node-html-parser';
import {
  type PlatformResult,
  normalizeForComparison,
  namesMatch,
} from './search-utils';

// ---------------------------------------------------------------------------
// Bandcamp
// ---------------------------------------------------------------------------

/**
 * True if this HTML is a Fastly bot-challenge interstitial rather than real content.
 *
 * Bandcamp serves the challenge with HTTP 200, so an `!response.ok` check never
 * catches it. Without this, a challenge parses to zero results and is
 * indistinguishable from "the artist genuinely isn't on Bandcamp" — a wrong
 * confident answer rather than a visible failure.
 *
 * Fastly's challenge page loads its assets from a `/_fs-ch-<token>/` path and
 * carries a restrictive inline CSP; the asset path is the stable marker.
 */
export function isBandcampChallenge(html: string): boolean {
  if (!html) return false;
  // Challenge pages are small; real Bandcamp pages are 100KB+. Cheap pre-filter.
  if (html.length > 20_000) return false;
  return html.includes('/_fs-ch-');
}

/** Parse Bandcamp search results HTML into PlatformResult[] */
export function parseBandcampSearchResults(html: string, query: string): PlatformResult[] {
  const results: PlatformResult[] = [];
  const root = parse(html);
  const resultItems = root.querySelectorAll('.searchresult');

  for (let i = 0; i < Math.min(10, resultItems.length); i++) {
    const item = resultItems[i];
    const resultType = item.querySelector('.result-info .itemtype')?.textContent?.trim().toLowerCase();
    const heading = item.querySelector('.result-info .heading a');
    const name = heading?.textContent?.trim();
    const url = heading?.getAttribute('href')?.split('?')[0];

    const subhead = item.querySelector('.result-info .subhead')?.textContent?.trim();
    let artist: string | undefined;
    if (subhead && subhead.startsWith('by ')) {
      artist = subhead.substring(3).trim();
    }

    const img = item.querySelector('.art img');
    const imageUrl = img?.getAttribute('src');

    if (name && url) {
      let type: 'artist' | 'album' | 'track' = 'artist';
      if (resultType === 'album') type = 'album';
      else if (resultType === 'track') type = 'track';

      // Filter: only include results where name matches the query
      const nameToCheck = type === 'artist' ? name : (artist || name);
      if (!namesMatch(nameToCheck, query)) continue;

      // Filter out fan profiles: bandcamp.com/username (path-based)
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.hostname === 'bandcamp.com') continue;
      } catch { /* invalid URL, skip */ }

      results.push({
        sourceId: 'bandcamp',
        name,
        artist,
        type,
        url,
        imageUrl: imageUrl || undefined,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Mirlo
// ---------------------------------------------------------------------------

/**
 * Parse Mirlo's artist search API response (`api.mirlo.space/v1/artists?name=`).
 *
 * Mirlo's `name` filter is a loose substring match over more than the visible
 * name (searching "the" returns "Other Nothing"), so results are re-checked
 * here: keep an artist only when their name contains the query or the query
 * contains their name. This is what makes partial searches work — "argent"
 * keeps "The Argent Grub" — while unrelated fuzz is dropped.
 */
export function parseMirloArtistSearch(data: unknown, query: string): PlatformResult[] {
  const results: PlatformResult[] = [];
  const queryNorm = normalizeForComparison(query);
  if (!queryNorm) return results;

  const artists = (data as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(artists)) return results;

  for (const entry of artists) {
    const artist = entry as {
      name?: unknown;
      urlSlug?: unknown;
      enabled?: unknown;
      deletedAt?: unknown;
    };
    if (typeof artist.name !== 'string' || typeof artist.urlSlug !== 'string') continue;
    if (artist.enabled === false || artist.deletedAt) continue;
    // The slug becomes a URL path segment; anything else is malformed data.
    if (!/^[a-z0-9._-]+$/i.test(artist.urlSlug)) continue;

    const nameNorm = normalizeForComparison(artist.name);
    if (!nameNorm) continue;
    if (!nameNorm.includes(queryNorm) && !queryNorm.includes(nameNorm)) continue;

    results.push({
      sourceId: 'mirlo',
      name: artist.name,
      type: 'artist',
      url: `https://mirlo.space/${artist.urlSlug}`,
    });
    if (results.length >= 5) break;
  }

  return results;
}

/** Parse a Mirlo artist page HTML to determine if the artist exists */
export function parseMirloArtistPage(html: string, normalizedQuery: string, artistUrl: string): PlatformResult | null {
  const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
  if (!ogTitleMatch) return null;

  const ogTitle = ogTitleMatch[1].toLowerCase();
  // If og:title is just "Mirlo", the artist doesn't exist
  if (ogTitle === 'mirlo') return null;
  if (!ogTitle.includes(normalizedQuery.substring(0, 4))) return null;

  const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
  const imageUrl = ogImageMatch ? ogImageMatch[1] : undefined;

  return {
    sourceId: 'mirlo',
    name: ogTitleMatch[1],
    type: 'artist',
    url: artistUrl,
    imageUrl,
  };
}

// ---------------------------------------------------------------------------
// Bandcamp releases
// ---------------------------------------------------------------------------

/**
 * Read a Bandcamp page's own claim about which band it belongs to.
 *
 * Every Bandcamp page carries `data-band="{"id":...,"name":"..."}"`. This is the
 * authoritative identity check when probing a guessed subdomain — a slug
 * existing does not mean it is the right artist. `thebeths.bandcamp.com`
 * resolves but is an unrelated account named "no content".
 */
export function parseBandcampBandIdentity(html: string): { id: number; name: string } | null {
  const match = html.match(/data-band="([^"]*)"/);
  if (!match) return null;
  try {
    // The attribute value is HTML-escaped JSON.
    const decoded = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    const parsed = JSON.parse(decoded) as { id?: unknown; name?: unknown };
    if (typeof parsed.id !== 'number' || typeof parsed.name !== 'string') return null;
    return { id: parsed.id, name: parsed.name };
  } catch {
    return null;
  }
}

/**
 * Releases listed in the sidebar discography of a Bandcamp album or track page.
 *
 * Bandcamp serves two layouts at `<slug>.bandcamp.com/music`. An artist with
 * several releases gets the `.music-grid-item` grid. An artist with a single
 * release gets a 303 to that release, and the album page it lands on has **no
 * grid at all** — the discography lives in a `#discography` sidebar instead:
 *
 *   <div id="discography" class="sidebar">
 *     <li><div class="trackTitle"><a href="/album/…">Subtitles For Blushing</a></div></li>
 *
 * Reading it is what stops a one-release artist from being mistaken for an empty
 * squatter. Measured on 2026-07-26: 5 of 13 `rejected_empty` verdicts were real
 * artists in this layout, Massive Attack and Yoko Kanno among them.
 */
function parseBandcampSidebarDiscography(root: HTMLElement): { href: string; title: string }[] {
  const sidebar = root.querySelector('#discography');
  if (!sidebar) return [];

  const entries: { href: string; title: string }[] = [];
  for (const link of sidebar.querySelectorAll('.trackTitle a')) {
    const href = link.getAttribute('href');
    if (!href) continue;
    entries.push({ href, title: link.textContent?.trim() ?? '' });
  }
  return entries;
}

/**
 * Count releases on a Bandcamp /music page, split by type.
 *
 * Zero albums AND zero tracks is the parked-squatter signature. Accounts at
 * `beyonce`, `sufjan` and `jackwhite` all exist and all return a matching
 * data-band name, but hold no releases — so a name check alone would surface
 * them as genuine artist pages.
 *
 * Handles both page layouts. The sidebar is only consulted when the grid is
 * empty, so a normal discography page behaves exactly as before.
 */
export function parseBandcampReleaseCounts(html: string): { albums: number; tracks: number } {
  const root = parse(html);
  const albums = new Set<string>();
  const tracks = new Set<string>();

  for (const item of root.querySelectorAll('.music-grid-item')) {
    // e.g. data-item-id="album-1507079760" / "track-526682361"
    const id = item.getAttribute('data-item-id');
    if (!id) continue;
    if (id.startsWith('album-')) albums.add(id);
    else if (id.startsWith('track-')) tracks.add(id);
  }

  if (albums.size > 0 || tracks.size > 0) {
    return { albums: albums.size, tracks: tracks.size };
  }

  // No grid. Either a genuinely empty account, or the single-release layout.
  for (const entry of parseBandcampSidebarDiscography(root)) {
    if (entry.href.includes('/album/')) albums.add(entry.href);
    else if (entry.href.includes('/track/')) tracks.add(entry.href);
  }

  return { albums: albums.size, tracks: tracks.size };
}

/**
 * Read the raw location string from a Bandcamp page, e.g. "Northampton, Massachusetts".
 *
 * Artist and /music pages carry this in a `class="location"` element. Returned raw so
 * the caller can run it through parseLocationString — this module stays I/O and
 * dependency free.
 *
 * Worth having because the probe already fetches /music: pulling location from that
 * same response saves a second round trip to a page we have in hand. Measured 89%
 * hit rate (16/18 long-tail artists; both misses have no location in Bandcamp's own
 * discover API either).
 */
export function parseBandcampPageLocation(html: string): string | null {
  const match = html.match(
    /<(?:p|div|span)[^>]+class="[^"]*\blocation\b[^"]*"[^>]*>([^<]+)<\/(?:p|div|span)>/,
  );
  if (!match) return null;
  const raw = match[1].replace(/\s+/g, ' ').trim();
  return raw.length > 0 && raw.length <= 120 ? raw : null;
}

/**
 * Read the artist photo from a Bandcamp page's og:image.
 *
 * Verified band-level rather than album art: radiohead/music yields
 * f4.bcbits.com/img/0040867508_23.jpg, which is exactly the image production already
 * shows for Radiohead. Free — the probe has this HTML in hand.
 *
 * This is the only source of the artist image: it used to come from the Qobuz match,
 * whose search path is robots-disallowed and has been retired.
 */
export function parseBandcampImage(html: string): string | null {
  const match = html.match(/<meta property="og:image" content="([^"]+)"/);
  if (!match) return null;
  const url = match[1].trim();
  // Bandcamp uses blank.gif as a placeholder; treat it as no image.
  if (!url.startsWith('https://') || url.includes('/blank.gif')) return null;
  return url;
}

/**
 * Parse Bandcamp /music page HTML to extract release titles.
 *
 * Falls back to the sidebar discography for the single-release layout, for the
 * same reason parseBandcampReleaseCounts does — and because a Bandcamp result
 * arriving with no titles forces disambiguation to spend its shared 4s release
 * budget re-fetching a page the probe already read.
 */
export function parseBandcampReleaseTitles(html: string): string[] {
  const root = parse(html);
  const titles: string[] = [];
  const musicGridItems = root.querySelectorAll('.music-grid-item');

  for (const item of musicGridItems) {
    const titleEl = item.querySelector('.title');
    const title = titleEl?.textContent?.trim();
    if (title) {
      titles.push(normalizeForComparison(title));
    }
    if (titles.length >= 20) break;
  }

  if (titles.length > 0) return titles;

  for (const entry of parseBandcampSidebarDiscography(root)) {
    if (entry.title) titles.push(normalizeForComparison(entry.title));
    if (titles.length >= 20) break;
  }

  return titles;
}

export interface BandcampGridRelease {
  /**
   * Bandcamp's own id for the release, e.g. "album-1891263657". Null in the
   * single-release sidebar layout, which doesn't carry one — callers that need a stable
   * key there should fall back to the resolved URL.
   */
  externalId: string | null;
  type: 'album' | 'track';
  /** As written in the page: usually root-relative ("/album/…"). Callers resolve it. */
  href: string;
  /** Display-quality title — original case, accents and punctuation intact. */
  title: string;
  artworkUrl: string | null;
}

/**
 * Every release on a Bandcamp `/music` page, with the identity and artwork the page
 * already carries.
 *
 * `parseBandcampReleaseTitles` reads the same grid but keeps only accent-folded titles,
 * because it exists to answer "is this the right artist?". This one exists to build a
 * catalog, so it keeps what that discards:
 *
 * - **`data-item-id`** — a stable per-release id, *and* an album-vs-track type prefix.
 *   Worth more than the title for identity: an artist can rename a release, but the id
 *   doesn't move, so re-reading a page updates a row instead of creating a second one.
 * - **`href`** — the release URL.
 * - **artwork** — `src`, or `data-original` when Bandcamp lazy-loads it.
 *
 * What is *not* here, deliberately: release dates. They are not in the grid at all — only
 * on individual release pages — so a catalog with dates costs one extra request per
 * release rather than coming free with this parse. Anything relying on dates has to opt
 * into that cost knowingly.
 *
 * Falls back to the `#discography` sidebar for the single-release layout, for the same
 * reason `parseBandcampReleaseCounts` does: a one-release artist is otherwise
 * indistinguishable from a parked account.
 */
export function parseBandcampGridReleases(html: string): BandcampGridRelease[] {
  const root = parse(html);
  const releases: BandcampGridRelease[] = [];
  const seen = new Set<string>();

  for (const item of root.querySelectorAll('.music-grid-item')) {
    if (releases.length >= MAX_GRID_RELEASES) break;

    const externalId = item.getAttribute('data-item-id') ?? null;
    const link = item.querySelector('a');
    const href = link?.getAttribute('href');
    const title = item.querySelector('.title')?.textContent?.trim();
    if (!href || !title) continue;

    // Prefer the id's prefix; fall back to the URL path when the attribute is missing.
    const type = releaseTypeFromIdOrHref(externalId, href);
    if (!type) continue;

    const dedupeKey = externalId ?? href;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    releases.push({
      externalId,
      type,
      href,
      // The grid renders a release's title and its artist on separate lines inside
      // .title for label pages; keep only the first line as the title.
      title: title.split('\n')[0].trim(),
      artworkUrl: artworkFrom(item),
    });
  }

  if (releases.length > 0) return releases;

  for (const entry of parseBandcampSidebarDiscography(root)) {
    if (releases.length >= MAX_GRID_RELEASES) break;
    const type = releaseTypeFromIdOrHref(null, entry.href);
    if (!type || !entry.title) continue;
    if (seen.has(entry.href)) continue;
    seen.add(entry.href);

    releases.push({
      externalId: null,
      type,
      href: entry.href,
      title: entry.title,
      artworkUrl: null,
    });
  }

  return releases;
}

/**
 * Upper bound on releases read from one page. Not a real Bandcamp limit — grids are
 * typically well under this — just a guard against a pathological page consuming the
 * whole function budget.
 */
const MAX_GRID_RELEASES = 500;

function releaseTypeFromIdOrHref(
  externalId: string | null,
  href: string
): 'album' | 'track' | null {
  if (externalId?.startsWith('album-')) return 'album';
  if (externalId?.startsWith('track-')) return 'track';
  if (href.includes('/album/')) return 'album';
  if (href.includes('/track/')) return 'track';
  return null;
}

function artworkFrom(item: HTMLElement): string | null {
  const img = item.querySelector('img');
  if (!img) return null;
  // data-original holds the real URL when the grid lazy-loads and src is a placeholder.
  const src = img.getAttribute('data-original') || img.getAttribute('src') || '';
  if (!src || src.startsWith('data:')) return null;
  return src;
}

// ---------------------------------------------------------------------------
// Bandcamp release pages — the date, the formats and the prices
// ---------------------------------------------------------------------------

/** One purchasable package on a Bandcamp release page, as the page states it. */
export interface BandcampDetailOffer {
  /** schema.org `musicReleaseFormat` with any URL prefix stripped: "VinylFormat", "CDFormat". */
  format: string | null;
  /** Bandcamp's own label for the package: "Digital", "2 x Vinyl LP", "Compact Disc (CD)". */
  typeName: string | null;
  price: number | null;
  /** ISO 4217, as given. */
  currency: string | null;
  /** schema.org `ItemAvailability`, prefix stripped: "InStock", "SoldOut", "PreOrder". */
  availability: string | null;
}

export interface BandcampReleaseDetail {
  /**
   * Exactly as the page writes it — "06 Oct 2023 00:00:00 GMT". Left unparsed here so the
   * sanity bounds live in one place (`parseReleaseDate` in release-utils).
   */
  datePublished: string | null;
  offers: BandcampDetailOffer[];
}

/**
 * Read a Bandcamp release page's date and purchase options.
 *
 * This is the data the whole Releases feature rests on — *"vinyl $25 · CD $12 · digital $10"* —
 * and it exists **only** here. The `/music` grid carries identity and artwork but no dates,
 * formats or prices at all, so a catalog with offers costs one request per release. Nothing
 * about that is avoidable; it's why the detail pass is budgeted rather than a blanket sweep.
 *
 * Read from the page's `application/ld+json` block, not the `data-tralbum` attribute that
 * also sits in the markup. The tralbum blob is richer (it has stock counts) but it is
 * Bandcamp's private page state, whereas the JSON-LD is a documented schema.org graph the
 * site publishes *for machines to read* — a stabler contract, and one we're plainly invited
 * to use. Where the two disagree in coverage we take the smaller honest answer: see the
 * standalone-track note below.
 *
 * Returns null when there's no usable JSON-LD, which callers must not confuse with "this
 * release has no offers" — one is us failing to read the page, the other is a fact about
 * the release.
 */
export function parseBandcampReleaseDetail(html: string): BandcampReleaseDetail | null {
  const graph = firstLdJsonWith(html, node => 'datePublished' in node || 'albumRelease' in node);
  if (!graph) return null;

  const datePublished = typeof graph.datePublished === 'string' ? graph.datePublished : null;

  // Albums (`MusicAlbum`) list every package — digital, vinyl, CD, cassette, merch — as a
  // top-level `albumRelease` entry with its own `offers`.
  //
  // Standalone track pages (`MusicRecording`) have no top-level `albumRelease`; theirs lives at
  // `inAlbum.albumRelease`. This used to be documented here as "track pages carry a date but no
  // offers at all", which was simply **wrong** — verified against live pages, a track's own
  // purchase is published in the JSON-LD with a real price *and* currency. Believing the old
  // note cost the catalogue a price on 183 of 777 Bandcamp sources (24%), every one of them a
  // `/track/` URL, which surfaced as "No formats listed on this page".
  const trackId = additionalProperty(graph.additionalProperty, 'track_id');
  const isTrackPage = !Array.isArray(graph.albumRelease);
  const inAlbum = isRecord(graph.inAlbum) ? graph.inAlbum : null;

  const releases = Array.isArray(graph.albumRelease)
    ? graph.albumRelease
    : Array.isArray(inAlbum?.albumRelease)
      ? inAlbum.albumRelease
      : [];

  const offers: BandcampDetailOffer[] = [];

  for (const entry of releases) {
    if (!isRecord(entry)) continue;
    if (!isThisReleasesItem(entry)) continue;
    for (const offer of asArray(entry.offers)) {
      if (!isRecord(offer)) continue;
      // On a track page the surrounding album's *physical* packages are listed too, and they
      // are not things you can buy of this track: a single would otherwise be published as
      // available on vinyl for $30, when that $30 buys the whole album. Bandcamp distinguishes
      // them in the offer URL — the track's own download is `#t{track_id}-buy`, every album
      // package is `#p{package_id}-buy` — so that is what's matched. Same class of problem as
      // `isThisReleasesItem` below, one level further in.
      if (isTrackPage && !isThisTracksOffer(offer, trackId)) continue;

      offers.push({
        format: stripSchemaPrefix(entry.musicReleaseFormat),
        typeName: additionalProperty(entry.additionalProperty, 'type_name'),
        price: asPrice(offer.price),
        currency: typeof offer.priceCurrency === 'string' ? offer.priceCurrency.toUpperCase() : null,
        availability: stripSchemaPrefix(offer.availability),
      });
    }
  }

  return { datePublished, offers };
}

/**
 * On a `MusicRecording` page, is this offer for the track itself rather than for the album it
 * belongs to?
 *
 * Matched on the offer URL's `#t{track_id}-buy` fragment. Refuses when the track id is unknown,
 * because without it there is nothing to tell the track's own download apart from the album's —
 * and publishing an album's vinyl price against a single track is a wrong number about what
 * someone is buying, which is worse than showing no price at all.
 */
function isThisTracksOffer(offer: Record<string, unknown>, trackId: string | null): boolean {
  if (!trackId) return false;
  const url = typeof offer.url === 'string' ? offer.url : '';
  return url.includes(`#t${trackId}-buy`);
}

/** `item_type` values that are something other than this release: see `isThisReleasesItem`. */
const CROSS_CATALOG_ITEM_TYPES = new Set(['i', 'b']);

/**
 * Is this `albumRelease` entry something you can buy *of this release*?
 *
 * An album page's `albumRelease` list is not only that album's packages. Bandcamp also parks
 * two whole-catalog products in it, both typed `DigitalFormat` and indistinguishable from the
 * album's own download except by `item_type`:
 *
 * - `i` — the artist's **monthly subscription**. Priced per month, not per record.
 * - `b` — the **full digital discography** bundle. Priced for every release at once.
 *
 * Left in, they become digital offers on this release, and `aggregateOffers` keeps the cheapest
 * digital price — so a $5 album next to a $3.33/month subscription is published as "$5 → $3.33".
 * That is a wrong price on a page whose entire job is being accurate about what an artist is
 * paid, and it happened: Kid Lightbulbs' albums were all quoting the subscription fee.
 *
 * A missing `item_type` is kept rather than dropped — the known intruders both carry one, and
 * refusing everything unlabelled would silently empty the offers on any page whose markup drifts.
 */
function isThisReleasesItem(entry: Record<string, unknown>): boolean {
  const itemType = additionalProperty(entry.additionalProperty, 'item_type');
  return !itemType || !CROSS_CATALOG_ITEM_TYPES.has(itemType.toLowerCase().trim());
}

/** First JSON-LD object in the page that satisfies `predicate`. Malformed blocks are skipped. */
function firstLdJsonWith(
  html: string,
  predicate: (node: Record<string, unknown>) => boolean
): Record<string, unknown> | null {
  const root = parse(html);
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      continue; // a broken block on the page is not a reason to give up on the page
    }
    for (const node of asArray(parsed)) {
      if (isRecord(node) && predicate(node)) return node;
    }
  }
  return null;
}

/**
 * "https://schema.org/InStock" and "InStock" mean the same thing, and JSON-LD publishers use
 * both forms interchangeably. Fold them so callers match on one spelling.
 */
function stripSchemaPrefix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^https?:\/\/schema\.org\//, '');
}

/** Value of a named entry in a schema.org `additionalProperty` list. */
function additionalProperty(list: unknown, name: string): string | null {
  for (const entry of asArray(list)) {
    if (!isRecord(entry)) continue;
    if (entry.name === name && (typeof entry.value === 'string' || typeof entry.value === 'number')) {
      return String(entry.value);
    }
  }
  return null;
}

/** Prices arrive as numbers here, but JSON-LD permits strings, so accept both. */
function asPrice(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-LD lets any property be a single value or an array of them. */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// Bandwagon
// ---------------------------------------------------------------------------

/** Parse Bandwagon search results HTML to extract artist links */
export function parseBandwagonSearchResults(html: string, query: string): Map<string, string> {
  const results = new Map<string, string>();
  const root = parse(html);
  const queryNormalized = normalizeForComparison(query);

  const artistLinks = root.querySelectorAll('a[href*="bandwagon.fm/@"]');
  const seen = new Set<string>();

  for (const link of artistLinks) {
    const href = link.getAttribute('href');
    const nameEl = link.querySelector('.bold');
    const name = nameEl?.textContent?.trim();

    if (href && name && !seen.has(href) && name.length > 0 && name.length < 100) {
      seen.add(href);
      const normalizedName = normalizeForComparison(name);

      if (normalizedName === queryNormalized ||
          normalizedName.includes(queryNormalized) ||
          queryNormalized.includes(normalizedName)) {
        if (!results.has(normalizedName)) {
          results.set(normalizedName, href);
        }
        if (results.size >= 10) break;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Jam.coop
// ---------------------------------------------------------------------------

/** Parse Jam.coop artists directory HTML to build a name→URL map */
export function parseJamcoopDirectory(html: string): Map<string, { name: string; url: string }> {
  const root = parse(html);
  const directory = new Map<string, { name: string; url: string }>();

  const artistLinks = root.querySelectorAll('a[href^="/artists/"]');

  for (const link of artistLinks) {
    const href = link.getAttribute('href');
    if (!href || href === '/artists') continue;

    const name = link.textContent?.trim();
    if (!name) continue;

    const normalizedName = normalizeForComparison(name);
    if (normalizedName && !directory.has(normalizedName)) {
      directory.set(normalizedName, {
        name,
        url: `https://jam.coop${href}`,
      });
    }
  }

  return directory;
}

// ---------------------------------------------------------------------------
// Faircamp
// ---------------------------------------------------------------------------

/** Parse Faircamp page HTML to extract release titles */
export function parseFaircampReleaseTitles(html: string): string[] {
  const root = parse(html);
  const titles: string[] = [];

  const releases = root.querySelectorAll('.release');
  for (const release of releases) {
    const links = release.querySelectorAll('a');
    if (links.length >= 2) {
      const title = links[1].textContent?.trim();
      if (title) titles.push(normalizeForComparison(title));
    }
  }

  return titles;
}

// ---------------------------------------------------------------------------
// Patreon
// ---------------------------------------------------------------------------

/** Parse Patreon search API JSON response into name→URL pairs */
export function parsePatreonSearchResults(data: {
  data?: {
    type: string;
    attributes?: {
      creator_name?: string;
      url?: string;
    };
  }[];
}): [string, string][] {
  const results: [string, string][] = [];
  const seen = new Set<string>();
  const campaigns = data.data || [];

  for (const campaign of campaigns) {
    if (campaign.type === 'campaign-document' && campaign.attributes) {
      const creatorName = campaign.attributes.creator_name;
      const url = campaign.attributes.url;

      if (creatorName && url) {
        const normalizedName = normalizeForComparison(creatorName);
        if (!seen.has(normalizedName)) {
          seen.add(normalizedName);
          results.push([normalizedName, url]);
        }
        const urlSlug = url.split('/').pop();
        if (urlSlug) {
          const normalizedSlug = normalizeForComparison(urlSlug);
          if (!seen.has(normalizedSlug)) {
            seen.add(normalizedSlug);
            results.push([normalizedSlug, url]);
          }
        }
      }
    }
    if (results.length >= 20) break;
  }

  return results;
}
