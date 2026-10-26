import { isUrlHostnameAllowed } from './middleware';
import { Sentry, withSentry } from '../lib/sentry';

// Weekly Unstream dispatch feed, at /digest/dispatch.xml. Unlisted: nothing on the site links
// to it, it isn't in the sitemap, and it answers with X-Robots-Tag: noindex.
//
// The feed is written by the "Unstream digest (Fri 9am)" cron to the `industry-digest`
// branch (dispatch.xml) and relayed here — the same pattern as digest-feed.ts. A separate
// function (rather than teaching digest-feed.ts about paths) keeps each feed's upstream URL
// hardcoded and the two digests fully independent: a change to one can never break the other.
//
// No rate limit: the CDN cache below answers almost every request, and a limiter would spend a
// metered Redis command per request to protect a single GitHub fetch.

export const UPSTREAM_URL =
  'https://raw.githubusercontent.com/brandonlucasgreen/unstream/industry-digest/dispatch.xml';

interface FeedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function failure(statusCode: number, body: string): FeedResponse {
  return {
    statusCode,
    // Never cached: a 404 here just means the first issue hasn't run yet, and a 502 is GitHub
    // not answering — neither should outlive the moment.
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body,
  };
}

async function handleRequest(event: { httpMethod?: string }): Promise<FeedResponse> {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'Method not allowed' };
  }

  if (!isUrlHostnameAllowed(UPSTREAM_URL)) {
    throw new Error('dispatch-feed: raw.githubusercontent.com is missing from ALLOWED_OUTBOUND_HOSTNAMES');
  }

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    Sentry.captureMessage('Dispatch digest feed: GitHub did not answer', {
      level: 'warning',
      extra: { error: (error as Error).message },
    });
    return failure(502, 'Feed temporarily unavailable');
  }

  if (upstream.status === 404) return failure(404, 'Not found');

  const body = upstream.ok ? await upstream.text() : '';
  // A 200 that isn't a feed (an error page, an empty file) is a failure, not a feed to relay.
  if (!upstream.ok || !body.includes('<rss')) {
    Sentry.captureMessage('Dispatch digest feed: unexpected upstream response', {
      level: 'warning',
      extra: { status: upstream.status, length: body.length },
    });
    return failure(502, 'Feed temporarily unavailable');
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'public, max-age=900',
      // The digest changes once a week, so the CDN holds it for an hour: a new issue takes at
      // most that long to appear here, and the function runs roughly once an hour at most.
      'CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
    body,
  };
}

export const handler = withSentry(handleRequest);
