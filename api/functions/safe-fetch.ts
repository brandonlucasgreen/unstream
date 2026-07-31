// One outbound-fetch path for anything that retrieves a URL we didn't hardcode.
//
// Extracted from check-releases.ts so it can be shared. The reason it must be shared rather
// than reimplemented: the checks here are not obvious, and each one exists because the
// obvious version was wrong.
//
//   1. Validating the URL you were *given* says nothing about the URL you *retrieve*.
//      Node's fetch follows redirects transparently, so redirects are resolved manually
//      here and every hop is re-validated.
//   2. A hostname string check is not an SSRF boundary. `169-254-169-254.nip.io` is an
//      ordinary public name that resolves to the cloud metadata address, and wildcard-DNS
//      services hand those out for free. Every hop is also resolved and every answer has to
//      be public.
//
// Any code fetching a URL that came from a request body, a database row, or scraped markup
// should use this. `isUrlHostnameAllowed` alone is not sufficient.

import { lookup } from 'dns/promises';
import { isPrivateIpAddress, isSafePublicHostname } from './middleware';

export const FETCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Bandcamp Pro artists point custom domains at their store, so a single request can
// legitimately redirect off *.bandcamp.com. Follow a few hops, validating each one.
export const MAX_REDIRECTS = 5;

/** Hostname for logging. The full URL may be caller-supplied, so it doesn't go in logs. */
export function safeHostname(urlString: string): string {
  try {
    return new URL(urlString).hostname;
  } catch {
    return '<unparseable>';
  }
}

/**
 * Does every DNS answer for this hostname point at a public address?
 *
 * String checks on a hostname are not enough, and this is the gap that made them
 * insufficient: `169-254-169-254.nip.io` is a perfectly ordinary public name that resolves
 * to 169.254.169.254 — the cloud metadata endpoint. Wildcard-DNS services hand those out
 * for free, and a Bandcamp Pro artist can point a custom domain anywhere, so an
 * allowlisted `*.bandcamp.com` input can redirect to a name that resolves into private
 * space. Nothing textual catches that; only resolution does.
 *
 * **All** answers must be public, so a dual-stack host can't smuggle a private AAAA past a
 * public A record. Any resolver failure or NXDOMAIN returns false — for a security
 * predicate, "couldn't check" has to mean "refuse".
 *
 * Residual risk, stated precisely rather than hand-waved: Node's `fetch` performs its own
 * resolution when it connects, so a hostname whose DNS answers *change* between this check
 * and that connect — rotating records or a very low TTL — can still slip through. Closing
 * that needs the connection pinned to the address we validated, which means a custom
 * undici dispatcher; `undici` isn't a declared dependency here (only transitively
 * available), so pinning is deliberately left as a follow-up rather than built on a package
 * that could vanish on any install. What this does close is the one-shot case, which is
 * what was actually reachable.
 */
export async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  if (!hostname || hostname === '<unparseable>') return false;
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    if (answers.length === 0) return false;
    return answers.every(a => !isPrivateIpAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Fetch with a timeout, validating **every** hop — both as a string and by resolution.
 *
 * Returns null when a target is refused or the redirect chain is too long. Callers treat
 * that the same as an unreachable host.
 *
 * Note this answers "is this target safe to fetch", **not** "are we allowed to fetch this
 * at all". Those are different questions and conflating them has already caused one bug:
 * an allowlist check belongs at the point where the URL enters the system, and when you
 * follow a link found inside fetched content you must additionally confine it (e.g. to the
 * host you landed on). See `checkBandcamp` in check-releases.ts for that pattern.
 */
export async function safeFetch(url: string, timeoutMs: number = 5000): Promise<Response | null> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafePublicHostname(current)) {
      console.warn(`[safe-fetch] refused unsafe fetch target: ${safeHostname(current)}`);
      return null;
    }

    if (!(await resolvesToPublicAddress(safeHostname(current)))) {
      console.warn(`[safe-fetch] refused target resolving to private space: ${safeHostname(current)}`);
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        headers: { 'User-Agent': FETCH_USER_AGENT },
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status < 300 || response.status >= 400) return response;

    // A 3xx with no Location has nowhere to go. Returning it as-is is deliberate rather
    // than unhandled: callers check `.ok`, which is false for a 3xx, so it fails closed.
    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current).toString();
  }

  console.warn(`[safe-fetch] too many redirects from ${safeHostname(url)}`);
  return null;
}
