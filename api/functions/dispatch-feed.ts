import { isUrlHostnameAllowed } from './middleware';
import { Sentry, withSentry } from '../lib/sentry';

// Weekly Unstream dispatch feed, at /digest/dispatch.xml. Unlisted: nothing on the site links
// to it, it isn't in the sitemap, and it answers with X-Robots-Tag: noindex.
//
// Not to be confused with /dispatch.xml, the frozen archive of the old Discord Dispatch that
// scripts/generate-dispatch-feed.ts builds at deploy time. This is a different, living feed.
//
// The writer is not in this repo: Brandon's "Unstream digest (Fri 9am)" scheduled agent commits
// dispatch.xml to the `industry-digest` branch every Friday, and this function relays it. Nothing
// here can notice that agent stopping, except the feed going stale, so a newest issue older than
// STALE_AFTER_DAYS is reported to Sentry (and still served: an old issue beats no feed).
//
// No rate limit: the CDN cache below answers almost every request, and a limiter would spend a
// metered Redis command per request to protect a single GitHub fetch.

export const UPSTREAM_URL =
  'https://raw.githubusercontent.com/brandonlucasgreen/unstream/industry-digest/dispatch.xml';

// Weekly, plus a day's grace for a late run.
export const STALE_AFTER_DAYS = 8;

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

/** The newest item's pubDate, or null for a feed with no dated items (before the first issue). */
export function newestIssueDate(feed: string): Date | null {
  let newest: Date | null = null;
  for (const item of feed.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
    const date = pubDate ? new Date(pubDate) : null;
    if (date && !Number.isNaN(date.getTime()) && (!newest || date > newest)) newest = date;
  }
  return newest;
}

// At most one report per function run, so about one an hour while stale; Sentry groups them.
function reportIfStale(feed: string): void {
  const newest = newestIssueDate(feed);
  if (!newest) return;
  const ageDays = (Date.now() - newest.getTime()) / 86_400_000;
  if (ageDays > STALE_AFTER_DAYS) {
    Sentry.captureMessage('Dispatch digest feed: no new issue, is the Friday agent still running?', {
      level: 'warning',
      extra: { newestIssue: newest.toISOString(), ageDays: Math.floor(ageDays) },
    });
  }
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

  reportIfStale(body);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'public, max-age=900',
      // The CDN holds it for an hour: a new issue takes at most that long to appear, and this
      // function (and its one GitHub fetch) runs about once an hour at most, whatever the traffic.
      'CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
    body,
  };
}

export const handler = withSentry(handleRequest);
