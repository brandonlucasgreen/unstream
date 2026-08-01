// Centralized middleware for API functions.
// Provides CORS, authentication, query validation, and SSRF protection.

import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader, errors as joseErrors } from 'jose';
import { getClient } from './db';

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const ALLOWED_ORIGIN = 'https://unstream.stream';

/**
 * Build CORS headers based on the request origin and auth method.
 *
 * - Requests with an API key: permissive CORS (any origin) since the key
 *   is the authorization mechanism, not the origin.
 * - Anonymous requests: restricted to unstream.stream only.
 */
export function buildCorsHeaders(
  origin: string | undefined,
  apiKeyPresent: boolean,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const allowOrigin = apiKeyPresent ? '*' : (origin && origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN);

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };
}

/**
 * Build public CORS headers for endpoints that don't require auth.
 * Allows any origin (existing behavior for public endpoints).
 */
export function buildPublicCorsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

// ---------------------------------------------------------------------------
// Authentication — Supabase JWT (Bearer token)
// ---------------------------------------------------------------------------

/**
 * Verify a Supabase JWT Bearer token and return the user ID + email.
 * Returns null if the token is missing, invalid, or expired.
 */
export async function authenticateBearer(
  authHeader: string | undefined,
): Promise<{ userId: string; email: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user || !data.user.email) return null;

  return { userId: data.user.id, email: data.user.email };
}

// ---------------------------------------------------------------------------
// Authentication — local JWT verification (fast path)
// ---------------------------------------------------------------------------

// Supabase signs access tokens either with the project's shared HS256 secret
// (legacy default — the "JWT Secret" under Settings → API, exposed here as
// SUPABASE_JWT_SECRET) or with asymmetric keys published at the project's
// JWKS endpoint. The JWKS client caches keys in module scope, so warm
// invocations verify with zero network calls.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(supabaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

interface BearerUser {
  userId: string;
  email: string;
}

/**
 * Verify a Supabase access token locally, without an auth-server round-trip.
 *
 * 'unavailable' means we couldn't check — missing SUPABASE_JWT_SECRET for an
 * HS256 token, JWKS unreachable, or an unknown key id (key rotation) — as
 * opposed to null, which means the token is definitively bad (garbage, bad
 * signature, expired, wrong audience/issuer). Callers treat 'unavailable' as
 * "ask the auth server instead" so a config gap never locks users out.
 */
async function verifyJwtLocally(token: string): Promise<BearerUser | null | 'unavailable'> {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  if (!supabaseUrl) return 'unavailable';

  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    return null; // not a JWT at all
  }

  // aud/iss checks keep non-user tokens (anon key, service key, tokens from
  // another project) from passing as a signed-in user — matching what the
  // auth server would reject.
  const claims = { issuer: `${supabaseUrl}/auth/v1`, audience: 'authenticated' };

  try {
    let payload;
    if (alg === 'HS256') {
      const secret = process.env.SUPABASE_JWT_SECRET;
      if (!secret) return 'unavailable';
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), { ...claims, algorithms: ['HS256'] }));
    } else {
      ({ payload } = await jwtVerify(token, getJwks(supabaseUrl), { ...claims, algorithms: ['RS256', 'ES256'] }));
    }
    if (!payload.sub) return null;
    return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
  } catch (err) {
    // ERR_JWKS_* covers fetch failures, timeouts, and unknown key ids — all
    // "couldn't check", not "bad token". Any other JOSE error is a real
    // verification failure. Anything else (e.g. a network TypeError) is
    // infrastructure, so fall back rather than reject.
    const code = (err as { code?: string }).code || '';
    if (code.startsWith('ERR_JWKS')) return 'unavailable';
    if (err instanceof joseErrors.JOSEError) return null;
    return 'unavailable';
  }
}

/**
 * Fast-path Bearer authentication for hot, latency-sensitive endpoints
 * (dashboard, saved artists, sync). Verifies the JWT locally and only calls
 * the auth server when local verification isn't possible.
 *
 * Trade-off (accepted in PR #331): a session revoked server-side (sign-out,
 * banned user) keeps working until the access token expires (~1 hour).
 * Use authenticateBearer where a fresh server-side check matters more than
 * latency — admin actions, API-key issuance.
 */
export async function authenticateBearerFast(
  authHeader: string | undefined,
): Promise<BearerUser | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const local = await verifyJwtLocally(token);
  if (local !== 'unavailable') return local;

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email || '' };
}

/**
 * Verify that the authenticated user is an admin.
 * Checks against the ADMIN_EMAIL env var.
 */
export async function authenticateAdmin(
  authHeader: string | undefined,
): Promise<{ userId: string; email: string } | null> {
  const user = await authenticateBearer(authHeader);
  if (!user) return null;

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return null;

  if (user.email.toLowerCase() !== adminEmail.toLowerCase()) return null;
  return user;
}

// ---------------------------------------------------------------------------
// Authentication — API key (X-API-Key header)
// ---------------------------------------------------------------------------

export interface ApiKeyInfo {
  id: string;
  keyPrefix: string;
  tier: 'free' | 'pro' | 'internal';
  dailyLimit: number;
  perMinute: number;
  ownerEmail: string;
}

/**
 * Validate an API key from the X-API-Key header.
 * Looks up the key prefix in Supabase, then compares SHA-256 hashes.
 * Returns null if the key is missing, invalid, or revoked.
 */
export async function authenticateApiKey(
  apiKeyHeader: string | undefined,
): Promise<ApiKeyInfo | null> {
  if (!apiKeyHeader) return null;

  const client = getClient();
  if (!client) return null;

  // Extract the prefix (first 12 chars: "usk_" + 8 hex) for lookup
  const prefix = apiKeyHeader.slice(0, 12);
  if (prefix.length < 12) return null;

  // Hash the full key with SHA-256
  const keyHash = createHash('sha256').update(apiKeyHeader).digest('hex');

  // Look up by prefix and compare hash
  const { data: keyRow, error } = await client
    .from('api_keys')
    .select('id, key_prefix, key_hash, tier, daily_limit, per_minute, owner_email, is_active')
    .eq('key_prefix', prefix)
    .eq('is_active', true)
    .single();

  if (error || !keyRow) return null;

  // Timing-safe hash comparison to prevent timing attacks
  const hashA = Buffer.from(keyRow.key_hash, 'hex');
  const hashB = Buffer.from(keyHash, 'hex');
  if (hashA.length !== hashB.length || !timingSafeEqual(hashA, hashB)) return null;

  // Update last_used_at (fire-and-forget)
  Promise.resolve(
    client
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', keyRow.id)
  ).catch(() => { /* no-op */ });

  return {
    id: keyRow.id,
    keyPrefix: keyRow.key_prefix,
    tier: keyRow.tier,
    dailyLimit: keyRow.daily_limit,
    perMinute: keyRow.per_minute,
    ownerEmail: keyRow.owner_email,
  };
}

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

const MAX_QUERY_LENGTH = 200;

/**
 * Validate a search query string.
 * Returns the cleaned query, or null if it should be rejected.
 */
export function validateQuery(query: string | null | undefined): { query: string } | { error: string } {
  if (!query || typeof query !== 'string') {
    return { error: 'Query parameter is required' };
  }

  // Strip control characters (except common whitespace)
  const cleaned = query.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();

  if (cleaned.length === 0) {
    return { error: 'Query cannot be empty' };
  }

  if (cleaned.length > MAX_QUERY_LENGTH) {
    return { error: `Query must be ${MAX_QUERY_LENGTH} characters or fewer` };
  }

  return { query: cleaned };
}

// ---------------------------------------------------------------------------
// SSRF protection — hostname allowlist for outbound fetches
// ---------------------------------------------------------------------------

export const ALLOWED_OUTBOUND_HOSTNAMES = new Set([
  // Music platforms
  'bandcamp.com',
  '*.bandcamp.com',       // artist.bandcamp.com subdomains
  'mirlo.space',
  '*.mirlo.space',
  // No qobuz.com: nothing fetches Qobuz any more. Its search paths are robots-disallowed
  // and its artist links now come from MusicBrainz relations, which we display but never
  // fetch. See docs/specs/qobuz-coverage-research.md.
  'www.bandwagon.fm',
  'jam.coop',
  'ampwall.com',
  '*.ampwall.com',
  'patreon.com',
  'www.patreon.com',
  'ko-fi.com',
  'buymeacoffee.com',
  'even.biz',
  '*.even.biz',
  'beatport.com',
  'www.beatport.com',
  'discogs.com',
  'www.discogs.com',
  // Discogs' actual database API (releases, masters, artist discographies) lives on this
  // subdomain, distinct from the www host used for social-link scraping above.
  'api.discogs.com',
  // Music metadata
  'musicbrainz.org',
  'beta.musicbrainz.org',
  'wikidata.org',
  'www.wikidata.org',
  'en.wikipedia.org',
  // Search / discovery
  'S64VD9CU46-dsn.algolia.net',
  'S64VD9CU46.algolianet.com',
  // Social / link-in-bio
  'linktr.ee',
  'linktree.com',
  // Video
  'peertube.social',
  'videos.trom.tf',
  // Sepia (MusicBrainz-linked)
  'sepia.disobey.info',
  'listenbrainz.org',
  'libre.fm',
  'archive.org',
  // Discord
  'discord.com',
  'discordapp.com',
]);

/**
 * Reject targets that are dangerous to fetch regardless of any allowlist: non-HTTP(S)
 * schemes, localhost, cloud metadata endpoints, and private or raw IP addresses.
 *
 * Split out from `isUrlHostnameAllowed` so callers that legitimately fetch hosts outside
 * the allowlist can still refuse internal targets. The motivating case is redirects:
 * Bandcamp Pro artists use custom domains (sufjanstevens.bandcamp.com 301s to
 * music.sufjan.com), so an allowlist check on the *input* URL says nothing about where
 * the request actually ends up. Validate every hop with this.
 *
 * This is a **string** check and cannot be the whole story. A textually ordinary public
 * hostname can resolve straight into private space — `169-254-169-254.nip.io` resolves to
 * the cloud metadata address — and no amount of inspecting the name catches that. It is not
 * a rebinding race; there is simply no resolution here. Callers that fetch the URL must
 * also check the resolved addresses with `isPrivateIpAddress` (see `resolvesToPublicAddress`
 * in check-releases.ts). Use this to reject obviously-bad targets, not as an SSRF boundary
 * on its own.
 */
export function isSafePublicHostname(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();

    // Only allow HTTPS and HTTP
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }

    // Block localhost and well-known metadata endpoints
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname === 'metadata.google.internal' ||
      hostname === '100.100.100.200'  // Alibaba/Tencent cloud metadata
    ) {
      return false;
    }

    // Block .local / .internal mDNS and private-namespace suffixes
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return false;
    }

    // Block any IPv6 address (no allowlisted hostnames are IPv6). `new URL()` keeps the
    // brackets, so this catches [::1], [::ffff:7f00:1], [fe80::…] and friends.
    if (hostname.includes(':')) {
      return false;
    }

    // Literal IPv4. No encoded-notation checks are needed here: `new URL()` has already
    // normalized decimal, octal, hex and short forms to dotted-decimal by this point
    // (verified — 2130706433, 0177.0.0.1, 0x7f.1 and 127.1 all arrive as "127.0.0.1"),
    // so a separate check for them would be dead code. Don't re-add one.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      return !isPrivateIpAddress(hostname);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Is this IP address in a range we must never fetch from?
 *
 * Operates on a resolved address, not a hostname — the point is to be callable *after* DNS
 * resolution, because a textually innocent hostname can resolve straight into private
 * space. `169-254-169-254.nip.io` is a public name that resolves to 169.254.169.254, and no
 * amount of string inspection catches it.
 *
 * Unrecognized input returns true (unsafe). This is a security predicate, so "I don't
 * understand this address" has to mean "refuse", never "allow".
 */
export function isPrivateIpAddress(address: string): boolean {
  const addr = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!addr) return true;

  // IPv4-mapped IPv6. Node normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1, so both the
  // dotted and the hex-group spellings have to be understood and judged as IPv4.
  const mapped = addr.match(/^::ffff:(.+)$/);
  if (mapped) {
    const inner = mapped[1];
    if (inner.includes('.')) return isPrivateIpv4(inner);
    const groups = inner.split(':');
    if (groups.length === 2) {
      const hi = parseInt(groups[0], 16);
      const lo = parseInt(groups[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
    return true;
  }

  if (addr.includes(':')) {
    if (addr === '::' || addr === '::1') return true;
    const lead = parseInt(addr.split(':')[0] || '0', 16);
    if (!Number.isFinite(lead)) return true;
    if ((lead & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((lead & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }

  return isPrivateIpv4(addr);
}

function isPrivateIpv4(address: string): boolean {
  const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true;
  const parts = m.slice(1).map(Number);
  if (parts.some(n => n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // whole loopback range, not just 127.0.0.1
  if (a === 169 && b === 254) return true; // link-local + AWS/Azure/GCP metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Check if a URL's hostname is in the SSRF allowlist.
 * Supports wildcard subdomains (*.domain).
 */
export function isUrlHostnameAllowed(urlString: string): boolean {
  try {
    // Dangerous-target checks first — an allowlisted name can never override them.
    if (!isSafePublicHostname(urlString)) return false;

    const hostname = new URL(urlString).hostname.toLowerCase();

    // Check exact match
    if (ALLOWED_OUTBOUND_HOSTNAMES.has(hostname)) return true;

    // Check wildcard match (*.domain)
    for (const pattern of ALLOWED_OUTBOUND_HOSTNAMES) {
      if (pattern.startsWith('*.')) {
        const domain = pattern.slice(2); // e.g. "bandcamp.com" from "*.bandcamp.com"
        if (hostname.endsWith('.' + domain)) return true;
      }
    }

    // Allow faircamp domains: "faircamp" must appear as a non-leftmost domain label.
    // artist.faircamp.net passes, but faircamp.evil.com does not (attacker-controlled).
    const labels = hostname.split('.');
    const fairIdx = labels.indexOf('faircamp');
    if (fairIdx > 0) return true;

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique request ID for tracing.
 */
export function generateRequestId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// V1 response envelope
// ---------------------------------------------------------------------------

export interface V1ResponseMeta {
  api_version: '1';
  request_id: string;
  rate_limit?: {
    limit: number;
    remaining: number;
    reset: number;
  };
}

export interface V1Response<T> {
  data: T;
  meta: V1ResponseMeta;
}

/**
 * Wrap response data in the v1 API envelope with metadata.
 */
export function v1Response<T>(
  data: T,
  requestId: string,
  rateLimitInfo?: { limit: number; remaining: number; reset: number },
): V1Response<T> {
  return {
    data,
    meta: {
      api_version: '1',
      request_id: requestId,
      ...(rateLimitInfo ? { rate_limit: rateLimitInfo } : {}),
    },
  };
}