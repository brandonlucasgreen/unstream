export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 3000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function generateResultId(name: string, artist?: string): string {
  const normalized = normalizeForComparison(artist ? `${artist}-${name}` : name);
  return normalized || Math.random().toString(36).substring(2);
}

export function textMatchScore(name: string, query: string): number {
  const normName = normalizeForComparison(name);
  const normQuery = normalizeForComparison(query);
  if (normName === normQuery) return 3;
  if (normName.startsWith(normQuery)) return 2;
  if (normName.includes(normQuery)) return 1;
  return 0;
}

export function parseReleaseDate(dateStr: string | undefined): Date | undefined {
  if (!dateStr) return undefined;

  // ISO format: 2024-12-06
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }

  // "Month Day, Year" format: December 6, 2024
  const monthDayYear = dateStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthDayYear) {
    const [, month, day, year] = monthDayYear;
    const monthIndex = new Date(`${month} 1, 2000`).getMonth();
    if (!isNaN(monthIndex)) {
      return new Date(parseInt(year), monthIndex, parseInt(day));
    }
  }

  // MM/DD/YYYY format (assume US)
  const slashDate = dateStr.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (slashDate) {
    const [, first, second, year] = slashDate;
    return new Date(parseInt(year), parseInt(first) - 1, parseInt(second));
  }

  return undefined;
}

/**
 * Build the `query` value for a MusicBrainz artist search: a quoted Lucene phrase.
 *
 * Dev-only mirror of `musicBrainzArtistQuery` in api/functions/search-utils.ts, which
 * is the canonical version — this tree cannot import from api/functions. Keep the two
 * in step; without the quotes, `artist:viagra boys` parses as `artist:viagra` OR a bare
 * `boys` and MusicBrainz returns "The Beach Boys".
 */
export function musicBrainzArtistQuery(query: string): string {
  const phrase = query.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return `artist:"${phrase}"`;
}
