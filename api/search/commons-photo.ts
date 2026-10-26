/**
 * An artist photo from Wikimedia Commons, with the credit its licence requires.
 *
 * Bandcamp's /music page is where search photos come from, and some artists' pages can't be
 * read: an artist on a custom domain (Zoë Keating, Sufjan Stevens) bounces every server-side
 * request between Bandcamp and their domain. Wikidata's P18 "image" is a photo on Commons,
 * and everything on Commons is freely licensed, so it can stand in. Never Wikipedia's lead
 * image: that can be a non-free local file such as an album cover.
 *
 * Free is not unconditional. CC BY and CC BY-SA require the author and licence to be shown
 * wherever the photo is, so a CommonsPhoto never travels without its credit. That is why it is
 * a field of its own and never `imageUrl`, which is stored on the artist row and saved
 * artists, drawn into social cards, and shown by shipped app builds, none of which carry a
 * credit.
 */
import { parse } from 'node-html-parser';

export interface CommonsPhoto {
  /** A thumbnail on one of Wikimedia's image hosts (IMAGE_HOSTS). */
  url: string;
  /** Plain text, e.g. "PopTech from Camden, Maine and Brooklyn, NY, USA". '' only for public domain. */
  author: string;
  /** Commons' short licence name, e.g. "CC BY-SA 2.0". */
  license: string;
  /** The Commons file page: the full attribution, licence and source live there. */
  sourceUrl: string;
}

/**
 * The outcome of looking up an artist's Commons photo. 'none' (no P18, or a licence we don't
 * accept) is cacheable; 'failed' (timeout, network, 5xx) is not.
 */
export type CommonsPhotoLookup =
  | { status: 'found'; photo: CommonsPhoto }
  | { status: 'none' }
  | { status: 'failed' };

const WIKIMEDIA_HEADERS = { 'User-Agent': 'Unstream/1.0 (https://unstream.stream)' };

// Wikimedia serves thumbnails in fixed steps and rounds other widths to them; 330 is a step,
// and twice the largest size a card draws the photo at.
const THUMBNAIL_WIDTH = 330;

// Licences whose terms a credit line satisfies. Anything else (GFDL-only, Free Art License,
// free-text "Attribution") is skipped rather than half-honoured.
const ATTRIBUTION_LICENSE = /^CC BY(-SA)? \d/i;
const PUBLIC_DOMAIN_LICENSE = /^(CC0|Public domain)/i;

const MAX_AUTHOR_LENGTH = 120;

// Where Commons serves images. Thumbnails moved to thumb.wikimedia.org (seen 2026-10-26);
// originals are still on upload.wikimedia.org.
const IMAGE_HOSTS = ['thumb.wikimedia.org', 'upload.wikimedia.org'];

/** The P18 filename on a Wikidata wbgetclaims response: preferred rank first, never deprecated. */
export function pickImageFilename(claimsResponse: unknown): string | null {
  const claims = (claimsResponse as {
    claims?: { P18?: { rank?: string; mainsnak?: { datavalue?: { value?: unknown } } }[] };
  })?.claims?.P18 ?? [];
  const usable = claims.filter(c => c.rank !== 'deprecated' && typeof c.mainsnak?.datavalue?.value === 'string');
  const chosen = usable.find(c => c.rank === 'preferred') ?? usable[0];
  return (chosen?.mainsnak?.datavalue?.value as string | undefined) ?? null;
}

/** A CommonsPhoto from a Commons imageinfo response, or null if it can't be credited properly. */
export function parseCommonsImageInfo(imageInfoResponse: unknown): CommonsPhoto | null {
  const pages = (imageInfoResponse as {
    query?: { pages?: Record<string, { imageinfo?: CommonsImageInfo[] }> };
  })?.query?.pages ?? {};
  const info = Object.values(pages)[0]?.imageinfo?.[0];
  if (!info?.thumburl || !info.descriptionurl) return null;

  const license = info.extmetadata?.LicenseShortName?.value?.trim() ?? '';
  const isPublicDomain = PUBLIC_DOMAIN_LICENSE.test(license);
  if (!isPublicDomain && !ATTRIBUTION_LICENSE.test(license)) return null;

  // Commons' Artist field is HTML (usually a link to the photographer's user page).
  const author = plainText(info.extmetadata?.Artist?.value ?? '');
  // An attribution licence with nobody to attribute can't be honoured.
  if (!isPublicDomain && !author) return null;

  // Both URLs end up in an <img src> and an <a href>; pin them to Wikimedia's own hosts.
  const url = withoutQuery(info.thumburl);
  if (!url || !isHttpsOn(url, IMAGE_HOSTS)) return null;
  if (!isHttpsOn(info.descriptionurl, ['commons.wikimedia.org'])) return null;

  return {
    url,
    author: author.length > MAX_AUTHOR_LENGTH ? `${author.slice(0, MAX_AUTHOR_LENGTH - 1).trimEnd()}…` : author,
    license,
    sourceUrl: info.descriptionurl,
  };
}

interface CommonsImageInfo {
  thumburl?: string;
  descriptionurl?: string;
  extmetadata?: Record<string, { value?: string }>;
}

function plainText(html: string): string {
  return parse(html).text.replace(/\s+/g, ' ').trim();
}

function isHttpsOn(url: string, hostnames: string[]): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && hostnames.includes(parsed.hostname);
  } catch {
    return false;
  }
}

// Commons appends utm_* tracking to thumbnail URLs; the image is the same without it.
function withoutQuery(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Look up the Commons photo for a Wikidata item (MusicBrainz's `wikidata` relation).
 * Two small, serial requests: the P18 claim alone, then that file's licence metadata.
 */
export async function fetchCommonsPhoto(wikidataUrl: string): Promise<CommonsPhotoLookup> {
  const qid = wikidataUrl.match(/\/(Q\d+)(?:[/?#]|$)/)?.[1];
  if (!qid) return { status: 'none' };
  try {
    const claimsResponse = await globalThis.fetch(
      `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json`,
      { headers: WIKIMEDIA_HEADERS, signal: AbortSignal.timeout(2500) },
    );
    if (!claimsResponse.ok) return { status: 'failed' };
    const filename = pickImageFilename(await claimsResponse.json());
    if (!filename) return { status: 'none' };

    const params = new URLSearchParams({
      action: 'query',
      titles: `File:${filename}`,
      prop: 'imageinfo',
      iiprop: 'url|extmetadata',
      iiurlwidth: String(THUMBNAIL_WIDTH),
      iiextmetadatafilter: 'LicenseShortName|Artist',
      format: 'json',
    });
    const infoResponse = await globalThis.fetch(
      `https://commons.wikimedia.org/w/api.php?${params}`,
      { headers: WIKIMEDIA_HEADERS, signal: AbortSignal.timeout(2500) },
    );
    if (!infoResponse.ok) return { status: 'failed' };
    const photo = parseCommonsImageInfo(await infoResponse.json());
    return photo ? { status: 'found', photo } : { status: 'none' };
  } catch {
    return { status: 'failed' };
  }
}
