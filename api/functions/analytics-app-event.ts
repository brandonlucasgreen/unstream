// POST /api/analytics/app-event
// Records anonymous product usage events from web, extension, and Mac app.
// No PII stored: session_hash is a keyed HMAC-SHA256 of (ip + user_agent + date).
// The HMAC key (SESSION_HASH_SECRET) makes the hash non-reversible even with
// knowledge of the input space, unlike plain SHA-256.

import { withSentry } from '../lib/sentry';
import { createHash, createHmac } from 'crypto';
import { getClient } from './db';
import { getClientIp } from './ratelimit';
import { endpoint, type EndpointResult, type PublicRequest } from './http/endpoint';

const VALID_EVENT_TYPES = new Set([
  'search',
  'platform_click',
  'extension_activated',
  'page_view',
  'release_alert',
  'download',
]);

const VALID_APPS = new Set(['web', 'extension', 'mac']);

const ALLOWED_CONTEXT_KEYS = new Set([
  'has_results', 'result_count', 'platform', 'streaming_service', 'page', 'search_kind', 'browser',
]);

// Keys the dashboard groups by with a fixed set of answers. Anything else is dropped rather than
// stored, so a stray value can't add a row to /admin/analytics.
const ALLOWED_CONTEXT_VALUES: Record<string, Set<string>> = {
  search_kind: new Set(['typed', 'now_playing']),
  browser: new Set(['chrome', 'firefox']),
};

function hashSessionId(ip: string, userAgent: string): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const raw = `${ip}:${userAgent}:${date}`;
  const secret = process.env.SESSION_HASH_SECRET;
  if (!secret) {
    // Fallback: plain SHA-256 if secret not configured. Events still recorded;
    // deduplication works but hashes are technically reversible.
    console.warn('[Analytics] SESSION_HASH_SECRET not set — falling back to plain SHA-256');
    return createHash('sha256').update(raw).digest('hex');
  }
  return createHmac('sha256', secret).update(raw).digest('hex');
}

async function handleRequest({ body, headers }: PublicRequest): Promise<EndpointResult> {
  const { event_type, app, context = {} } = body as {
    event_type?: string;
    app?: string;
    context?: Record<string, unknown>;
  };

  if (!event_type || !VALID_EVENT_TYPES.has(event_type)) {
    return { status: 204 };
  }

  if (!app || !VALID_APPS.has(app)) {
    return { status: 204 };
  }

  const client = getClient();
  if (!client) {
    return { status: 204 };
  }

  // Sanitize context: only allow primitive values, strip any PII fields
  const safeContext: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (!ALLOWED_CONTEXT_KEYS.has(k)) continue;
    if (!(typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')) continue;
    const allowedValues = ALLOWED_CONTEXT_VALUES[k];
    if (allowedValues && !allowedValues.has(String(v))) continue;
    safeContext[k] = v;
  }

  const userAgent = headers['user-agent'] || '';
  const sessionHash = hashSessionId(getClientIp(headers), userAgent);

  // Supabase JS client returns { error } rather than throwing — check it explicitly
  const { error: insertError } = await client.from('app_events').insert({
    event_type,
    app,
    context: safeContext,
    session_hash: sessionHash,
  });
  if (insertError) {
    console.error('[Analytics] Failed to insert app_event:', insertError);
  }

  return { status: 204 };
}

export const handler = withSentry(endpoint({
  cors: 'public',
  methods: ['POST'],
  auth: 'none',
  // Clients fire these and forget them, so a limited one is simply dropped.
  rateLimit: 'standard',
  jsonBody: true,
}, handleRequest));
