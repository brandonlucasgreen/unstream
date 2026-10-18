// Save a search's artists and links without making the search wait for it.
//
// persistSearchResults used to run inline, awaited before the response was sent, so every
// uncached search paid for its reads and writes — one to five Supabase round trips per artist,
// more for an artist we had never seen — before a fan saw a single result. Nothing in the
// response depends on those writes (persistSearchResults reads the cards and never changes
// them), so the work is handed to a Netlify Background Function with one HTTP call that Netlify
// answers with 202 as soon as it's accepted: the same handshake as request-catalog.ts.
//
// What the response path still pays is that handshake. When it can't happen — no
// configuration, a payload too big for a background invocation, a refused or failed request —
// the results are persisted inline exactly as before, so a dispatch problem costs latency,
// never data. persistSearchResults is idempotent (upserts, diffed against what's stored), so a
// handshake that times out after it was in fact accepted only means the same rows are compared
// twice.

import { Sentry } from '../lib/sentry';
import { persistSearchResults, type PersistableResult } from './db';
import { checkSentryDedup } from './ratelimit';

/**
 * The most this sends to the background function, in bytes of JSON.
 *
 * A background invocation is an asynchronous Lambda call, whose whole request is capped at
 * 256 KB — Netlify documents it as a fixed limit, unlike the 6 MB of a synchronous function.
 * That cap covers the request Netlify wraps around this body too, hence the headroom. A typical
 * search's payload is a few kilobytes; the trimming in `toPersistPayload` is what keeps it there.
 */
export const MAX_PERSIST_PAYLOAD_BYTES = 200_000;

/** The handshake is on the response path, so it gets far less patience than a crawl request. */
const DISPATCH_TIMEOUT_MS = 1_500;

/** How the response path handled persistence, for the `persist` entry in Server-Timing. */
export type PersistMode =
  | 'none'
  | 'background'
  | 'inline-unconfigured'
  | 'inline-oversize'
  | 'inline-dispatch-failed'
  | 'error';

/**
 * Where to call our own background functions.
 *
 * **Not `URL`, which is what request-catalog.ts uses.** `URL` is https://unstream.stream, and that
 * zone has had Cloudflare's Bot Fight Mode on since 2026-10-12. On the free plan it has no
 * exceptions and challenges datacenter traffic before any skip rule runs — the release sweep's
 * GitHub runner was answered "Just a moment…" until it moved to the netlify.app host (#606), and
 * a Lambda's request comes from AWS just as the runner's came from Microsoft. The site's own
 * `<SITE_NAME>.netlify.app` hostname is served by Netlify directly, outside Cloudflare.
 *
 * `SITE_NAME` is one of the three variables Netlify exposes to a function at runtime (with `URL`
 * and `SITE_ID`). A preview resolves to the *production* host here too, as request-catalog's
 * `URL` does, since a preview can't name itself at runtime. Under `netlify dev`, `URL` is
 * localhost and is used as is, so local runs exercise the local function.
 */
export function internalFunctionOrigin(): string | null {
  const siteUrl = process.env.URL;
  const siteName = process.env.SITE_NAME;
  if (siteUrl && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(siteUrl)) return siteUrl;
  if (siteName && /^[a-z0-9-]+$/.test(siteName)) return `https://${siteName}.netlify.app`;
  return siteUrl || null;
}

/**
 * Only what persistSearchResults reads: artist cards, and from each one its name, image,
 * verdict and platform links. Everything else on a card — `allReleaseTitles` in particular,
 * which can run to dozens of titles per platform — stays behind.
 */
export function toPersistPayload(results: PersistableResult[]): PersistableResult[] {
  return results
    .filter(r => r.type === 'artist')
    .map(r => ({
      type: r.type,
      name: r.name,
      imageUrl: r.imageUrl,
      matchConfidence: r.matchConfidence,
      platforms: r.platforms.map(p => ({ sourceId: p.sourceId, url: p.url, latestRelease: p.latestRelease })),
    }));
}

/**
 * The background function's side of `toPersistPayload`: read a request body back into results,
 * dropping anything that isn't shaped like one. The function is behind the internal secret, so
 * this is a boundary check rather than a defence against a hostile caller. Returns null when the
 * body isn't a payload at all.
 */
export function parsePersistPayload(body: unknown): PersistableResult[] | null {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;

  const parsed: PersistableResult[] = [];
  for (const item of results as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'artist' || typeof item.name !== 'string' || !Array.isArray(item.platforms)) continue;

    const platforms = (item.platforms as Record<string, unknown>[])
      .filter(p => p && typeof p.sourceId === 'string' && typeof p.url === 'string')
      .map(p => ({
        sourceId: p.sourceId as string,
        url: p.url as string,
        latestRelease: p.latestRelease && typeof p.latestRelease === 'object' ? p.latestRelease : undefined,
      }));

    parsed.push({
      type: 'artist',
      name: item.name,
      imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : undefined,
      matchConfidence: typeof item.matchConfidence === 'string' ? item.matchConfidence : undefined,
      platforms,
    });
  }
  return parsed;
}

/**
 * Persist a search's results, in the background when possible. Never throws: a search must not
 * fail because its results couldn't be saved.
 *
 * Awaited by the caller, like requestArtistCatalog: un-awaited work is killed when the Lambda
 * freezes after the response, so a floating promise would sometimes never leave. What's awaited
 * is the 202 handshake, or the inline fallback when there's no handshake to make.
 */
export async function requestSearchPersist(results: PersistableResult[]): Promise<PersistMode> {
  try {
    const payload = toPersistPayload(results);
    if (payload.length === 0) return 'none';

    const secret = process.env.INTERNAL_FUNCTION_SECRET;
    const origin = internalFunctionOrigin();
    if (!secret || !origin) {
      // The unit tests, and any environment without the secret: persist the way search always
      // did. Not reported — it's configuration, not a failure.
      await persistSearchResults(payload);
      return 'inline-unconfigured';
    }

    const body = JSON.stringify({ results: payload });
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_PERSIST_PAYLOAD_BYTES) {
      await reportDispatchProblem('oversize', `payload ${bytes} bytes for ${payload.length} artists`);
      await persistSearchResults(payload);
      return 'inline-oversize';
    }

    const dispatched = await dispatch(origin, secret, body);
    if (dispatched !== true) {
      await reportDispatchProblem('failed', dispatched);
      await persistSearchResults(payload);
      return 'inline-dispatch-failed';
    }
    return 'background';
  } catch (error) {
    // persistSearchResults catches per artist, so reaching here means something around it broke.
    console.error('[persist] search persistence failed:', error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { extra: { context: 'request-persist' } });
    return 'error';
  }
}

/** True on a 202, otherwise a short description of what went wrong. */
async function dispatch(origin: string, secret: string, body: string): Promise<true | string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}/.netlify/functions/persist-search-results-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body,
      signal: controller.signal,
    });
    // Netlify answers 202 the moment it accepts a background invocation. Anything else — above
    // all a 403 "Just a moment…" from a bot challenge, which doesn't throw — means the work was
    // not handed over.
    return response.status === 202 ? true : `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * A dispatch problem costs latency rather than data, so it's a warning, not an error — but a
 * silent one would leave search quietly back on the slow path forever. Deduped per kind per hour,
 * so a persistent break is one event an hour rather than one per search.
 */
async function reportDispatchProblem(kind: 'oversize' | 'failed', detail: string): Promise<void> {
  console.warn(`[persist] background dispatch ${kind} (${detail}), persisting inline`);
  if (await checkSentryDedup(`persist-dispatch-${kind}`, 60 * 60)) {
    Sentry.captureMessage(`[persist] search persistence fell back to inline: ${kind}`, {
      level: 'warning',
      tags: { persist_dispatch: kind },
      extra: { detail },
    });
  }
}
