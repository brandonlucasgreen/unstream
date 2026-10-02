// MusicBrainz enrichment server function (Phase 2). The enrichment itself lives in
// musicbrainz-enrichment.ts, shared with Phase 1 under one cache entry.

import { Sentry } from '../lib/sentry';
import { persistEnrichment, getLinkSuppressions } from './db';
import { checkRateLimit, checkSentryDedup, getClientIp } from './ratelimit';
import { validateQuery } from './middleware';
import { normalizeSearchQuery, isUrlSuppressed, type LinkSuppression } from './search-utils';
import {
  getMusicBrainzEnrichment,
  toMusicBrainzResponse,
  type MusicBrainzSearchResponse,
} from './musicbrainz-enrichment';

/** Response shape used when MusicBrainz did not answer. Cached for a minute at most. */
function unavailableResult(query: string): MusicBrainzSearchResponse {
  return {
    query,
    artistName: null,
    officialUrl: null,
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [],
    discoveredPlatforms: [],
    platformUrls: [],
    wikipediaSummary: null,
    wikipediaUrl: null,
    location: undefined,
    bio: null,
    bioFetchFailed: false,
  };
}

/**
 * Drop links an admin has suppressed for this artist.
 *
 * Applied to the response *after* the cache read, never inside the cached
 * function: a suppression added today must take effect on the next request
 * rather than waiting out a day-long cache entry. Phase 1 does the same at the
 * end of its own pipeline (applyLinkSuppressions), but this endpoint's links are
 * merged into the results client-side, so they need their own pass — otherwise a
 * removed link reappears the moment enrichment lands.
 */
function stripSuppressedLinks(
  result: MusicBrainzSearchResponse,
  suppressions: LinkSuppression[],
): MusicBrainzSearchResponse {
  if (suppressions.length === 0 || !result.artistName) return result;

  const artistName = result.artistName;
  const suppressed = (url: string) => isUrlSuppressed(url, artistName, suppressions);

  return {
    ...result,
    officialUrl: result.officialUrl && suppressed(result.officialUrl) ? null : result.officialUrl,
    discogsUrl: result.discogsUrl && suppressed(result.discogsUrl) ? null : result.discogsUrl,
    socialLinks: result.socialLinks.filter(s => !suppressed(s.url)),
    discoveredPlatforms: result.discoveredPlatforms.filter(p => !suppressed(p.url)),
    platformUrls: result.platformUrls.filter(u => !suppressed(u)),
    // A suppressed link says that page isn't this artist — so neither is its bio.
    bio: result.bio && suppressed(result.bio.sourceUrl) ? null : result.bio,
  };
}

// Netlify function handler
export async function handler(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string> }) {
  const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'strict', corsHeaders);
  if (rl.limited) return rl.response;

  const queryResult = validateQuery(event.queryStringParameters?.query);
  if ('error' in queryResult) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: queryResult.error }),
    };
  }
  const query = queryResult.query;

  try {
    // Normalize the query to handle accented characters (e.g., "Tanerélle" -> "Tanerelle")
    const normalizedQuery = normalizeSearchQuery(query);

    // Rides along with the MusicBrainz round-trips below instead of adding a
    // serial hop. getLinkSuppressions catches its own errors ([] on failure).
    const suppressionsPromise = getLinkSuppressions();

    // The same cache entry Phase 1 reads, so this answer also speeds up the next search.
    // Failures and partial answers are kept only for a minute (see isCacheableMbResult).
    const { data: enrichment, cached } = await getMusicBrainzEnrichment(normalizedQuery);
    const result = toMusicBrainzResponse(enrichment);

    if (cached) {
      console.log('[MusicBrainz] Cache hit');
    }

    if (result === null) {
      const shouldCapture = await checkSentryDedup('uns152:musicbrainz-unavailable', 30 * 60);
      if (shouldCapture) {
        Sentry.captureMessage('MusicBrainz did not answer; enrichment skipped', {
          level: 'warning',
          extra: { query: normalizedQuery, note: 'Kept for the one-minute failure TTL only.' },
        });
      }
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          // Do not let the CDN cache an unavailable upstream either.
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(unavailableResult(query)),
      };
    }

    // Suppressed links are stripped before anything else sees them, so they are
    // neither returned to the client nor persisted into the artist database.
    const filtered = stripSuppressedLinks(result, await suppressionsPromise);

    // Persist enrichment to the artist database.
    // Also persist on MB-miss if we at least captured location (from the
    // Bandcamp/Mirlo fallback), keyed on the normalized query's slug.
    const persistName = filtered.artistName || (filtered.location ? normalizedQuery : null);
    if (persistName) {
      try {
        await persistEnrichment(persistName, filtered);
      } catch (err) {
        console.error('[DB] Background enrichment persist failed:', err);
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=300, stale-while-revalidate',
      },
      body: JSON.stringify(filtered),
    };
  } catch (error) {
    console.error('MusicBrainz endpoint error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        query,
        artistName: null,
        officialUrl: null,
        discogsUrl: null,
        hasPre2005Release: false,
        socialLinks: [],
        discoveredPlatforms: [],
        wikipediaSummary: null,
        wikipediaUrl: null,
      }),
    };
  }
}
