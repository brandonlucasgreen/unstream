import { isUrlHostnameAllowed } from './middleware';
import { Sentry, withSentry } from '../lib/sentry';

// The weekly industry digest's feed, at /digest/feed.xml. Unlisted: nothing on the site links to
// it, it isn't in the sitemap, and it answers with X-Robots-Tag: noindex.
//
// The feed itself is written by .github/workflows/industry-digest.yml to the `industry-digest`
// branch (scripts/industry-digest/README.md), and this function relays it. Relaying rather than
// copying the file into apps/web/public/ is the point: a copy would need a production deploy
// for every weekly issue, and keep the digest in main. A Netlify proxy redirect can't do it
// either — GitHub serves raw files as text/plain, and netlify.toml headers aren't applied to
// proxied responses, so readers would get the wrong Content-Type.
//
// No rate limit: the CDN cache below answers almost every request, and a limiter would spend a
// metered Redis command per request to protect a single GitHub fetch.

export const UPSTREAM_URL =
  'https://raw.githubusercontent.com/brandonlucasgreen/unstream/industry-digest/feed.xml';

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
    throw new Error('digest-feed: raw.githubusercontent.com is missing from ALLOWED_OUTBOUND_HOSTNAMES');
  }

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    Sentry.captureMessage('Digest feed: GitHub did not answer', {
      level: 'warning',
      extra: { error: (error as Error).message },
    });
    return failure(502, 'Feed temporarily unavailable');
  }

  if (upstream.status === 404) return failure(404, 'Not found');

  const body = upstream.ok ? await upstream.text() : '';
  // A 200 that isn't a feed (an error page, an empty file) is a failure, not a feed to relay.
  if (!upstream.ok || !body.includes('<rss')) {
    Sentry.captureMessage('Digest feed: unexpected upstream response', {
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
      'Netlify-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
    body,
  };
}

export const handler = withSentry(handleRequest);
