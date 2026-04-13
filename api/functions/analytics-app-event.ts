// POST /api/analytics/app-event
// Records anonymous product usage events from web, extension, and Mac app.
// No PII stored: session_hash is a keyed HMAC-SHA256 of (ip + user_agent + date).
// The HMAC key (SESSION_HASH_SECRET) makes the hash non-reversible even with
// knowledge of the input space, unlike plain SHA-256.

import { createHash, createHmac } from 'crypto';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VALID_EVENT_TYPES = new Set([
  'search',
  'platform_click',
  'extension_activated',
  'page_view',
  'release_alert',
]);

const VALID_APPS = new Set(['web', 'extension', 'mac']);

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

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: '' };
  }

  // Lenient rate limit — fire-and-forget from clients
  const ip = getClientIp(event.headers);
  const rl = await checkRateLimit(ip, 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  let body: { event_type?: string; app?: string; context?: Record<string, unknown> };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const { event_type, app, context = {} } = body;

  if (!event_type || !VALID_EVENT_TYPES.has(event_type)) {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!app || !VALID_APPS.has(app)) {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // Sanitize context: only allow primitive values, strip any PII fields
  const safeContext: Record<string, unknown> = {};
  const ALLOWED_CONTEXT_KEYS = new Set([
    'has_results', 'result_count', 'platform', 'streaming_service', 'page',
  ]);
  for (const [k, v] of Object.entries(context)) {
    if (ALLOWED_CONTEXT_KEYS.has(k) && (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')) {
      safeContext[k] = v;
    }
  }

  const userAgent = event.headers['user-agent'] || '';
  const sessionHash = hashSessionId(ip, userAgent);

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

  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}
