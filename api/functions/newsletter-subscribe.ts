// API endpoint: /api/newsletter/subscribe
// POST — adds an email address to the Unstream newsletter on Buttondown.
// Body: { email: string, source?: 'changelog' | 'guides' | 'contact' }
//
// Deliberately not offered from /settings: that page already has its own opt-out toggles for
// product email (see notification_preferences / NotificationPreferences.tsx), and pairing that
// with an opt-*in* newsletter form in the same section read as "you still need to sign up for
// this" even to people already getting product email. Buttondown signup lives only where
// someone has just shown interest in a specific kind of content — guides, changelog — or has
// come to /contact, which is by definition someone who wants to hear back.
//
// Why a proxy rather than Buttondown's own embed: the embed needs third-party script and
// frame hosts in the CSP and can't be styled to match the site. Going through a function
// keeps the CSP as it is, keeps the API key server-side, gets the form the same per-IP rate
// limiting as everything else, and lets us tag each signup with where it came from.
//
// Double opt-in: a subscriber created without an explicit `type` lands in Buttondown as
// `unactivated` and is emailed a confirmation link. That's deliberate — this form is public,
// so anyone can type in an address that isn't theirs, and the confirmation click is what
// stops that becoming somebody else's problem. Don't add `type: 'regular'` to "reduce
// friction": it converts the form into a way to sign strangers up for mail.

import { Sentry } from '../lib/sentry';
import { checkRateLimit, getClientIp } from './ratelimit';

// Matches the permissive pattern used by the other browser-facing POST endpoints
// (me-username.ts, saved-artists.ts). No credentials are involved — the request carries
// only an email address the visitor just typed.
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'X-Content-Type-Options': 'nosniff',
};

// A module constant, not built from request input, so there's no SSRF surface here and
// nothing for ALLOWED_OUTBOUND_HOSTNAMES to guard. Don't make this configurable.
const BUTTONDOWN_SUBSCRIBERS_URL = 'https://api.buttondown.com/v1/subscribers';

const UPSTREAM_TIMEOUT_MS = 8000;

// Tags let Buttondown segment by where somebody signed up. `source` is client-supplied and
// Buttondown creates tags on demand, so anything off this list is dropped rather than
// forwarded — otherwise a stranger with curl could fill the account with junk tags.
const ALLOWED_SOURCES = new Set(['changelog', 'guides', 'contact']);

// Deliberately loose. Address syntax is far more permissive than any regex people actually
// write, and the confirmation email is the real check — this only catches obvious typos and
// keeps junk out of the upstream call.
const EMAIL_REGEX = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 maximum path length

function json(statusCode: number, body: Record<string, unknown>) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  const rl = await checkRateLimit(ip, 'strict', CORS_HEADERS);
  if (rl.limited && rl.response) return rl.response;

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email) {
    return json(400, { error: 'Enter your email address.' });
  }
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(email)) {
    return json(400, { error: "That doesn't look like an email address." });
  }

  const rawSource = typeof body.source === 'string' ? body.source : '';
  const source = ALLOWED_SOURCES.has(rawSource) ? rawSource : null;

  const apiKey = process.env.BUTTONDOWN_API_KEY;
  if (!apiKey) {
    // A missing env var must never read as a successful signup — that loses subscribers
    // silently, which is the failure mode nobody notices until the list is a month short.
    Sentry.captureMessage('newsletter-subscribe: BUTTONDOWN_API_KEY is not set', 'error');
    return json(503, { error: 'The newsletter is temporarily unavailable. Please try again later.' });
  }

  let response: Response;
  try {
    response = await fetch(BUTTONDOWN_SUBSCRIBERS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email_address: email,
        ...(source ? { tags: [source] } : {}),
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeout or network failure. We don't know whether the subscriber was created, so say
    // so rather than guessing in either direction.
    Sentry.captureException(error, { extra: { context: 'newsletter-subscribe.fetch', source } });
    return json(502, { error: "We couldn't reach the newsletter service. Please try again." });
  }

  const raw = await response.text();
  let payload: { code?: string; detail?: string } = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    // Non-JSON body — handled by the status checks below.
  }

  if (response.ok) {
    return json(200, { status: 'pending' });
  }

  // Buttondown rejects a duplicate address with 400 + code "email_already_exists". Reporting
  // that as an error would be wrong and confusing — from the visitor's side, being on the
  // list is exactly what they asked for.
  if (response.status === 400 && payload.code === 'email_already_exists') {
    return json(200, { status: 'already_subscribed' });
  }

  // Buttondown's own validation of the address (disposable domains, hard bounces, spam
  // signals). Worth showing the visitor, since only they can fix it.
  if (response.status === 400 && payload.code === 'email_invalid') {
    return json(400, { error: "Buttondown wouldn't accept that address. Try a different one." });
  }

  // Anything else is ours to fix, not the visitor's: a revoked key, a changed API contract,
  // an outage. Report it with enough detail to diagnose, and never the email address itself.
  Sentry.captureMessage(
    `newsletter-subscribe: Buttondown returned ${response.status} (${payload.code || 'no code'})`,
    'error',
  );
  return json(502, { error: "Something went wrong signing you up. Please try again." });
}
