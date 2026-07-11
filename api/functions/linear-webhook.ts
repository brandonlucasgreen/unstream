// POST /api/linear-webhook
// Linear webhook — verifies the Linear-Signature HMAC, filters for new Issues,
// and dispatches to a background function for Claude Code triage.
// See https://linear.app/developers/webhooks

import { createHmac, timingSafeEqual } from 'crypto';
import { Sentry } from '../lib/sentry';

const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET || '';
const MAX_TIMESTAMP_SKEW_MS = 60_000;

interface LinearIssuePayload {
  action: string;
  type: string;
  data: {
    id: string;
    identifier?: string;
    title?: string;
    description?: string;
    priority?: number;
    url?: string;
    team?: { key?: string; name?: string };
    state?: { name?: string };
  };
  url?: string;
  webhookTimestamp?: number;
}

function isValidSignature(rawBody: string, signatureHeader: string): boolean {
  const expected = createHmac('sha256', LINEAR_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(signatureHeader, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!event.body) {
    return { statusCode: 400, body: 'Missing body' };
  }

  if (!LINEAR_WEBHOOK_SECRET) {
    Sentry.captureMessage('linear-webhook: LINEAR_WEBHOOK_SECRET not configured', { level: 'error' });
    return { statusCode: 500, body: 'Not configured' };
  }

  const signature = event.headers['linear-signature'];
  if (!signature || !isValidSignature(event.body, signature)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload: LinearIssuePayload;
  try {
    payload = JSON.parse(event.body);
  } catch (_error) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (payload.webhookTimestamp && Math.abs(Date.now() - payload.webhookTimestamp) > MAX_TIMESTAMP_SKEW_MS) {
    return { statusCode: 401, body: 'Stale timestamp' };
  }

  if (payload.type !== 'Issue' || payload.action !== 'create') {
    // Acknowledge other event types without acting on them.
    return { statusCode: 200, body: 'Ignored' };
  }

  const siteUrl = process.env.URL || 'https://unstream.stream';

  // Await the dispatch call itself (not the background function's full run) —
  // an un-awaited fetch can be killed when this handler returns and Lambda
  // freezes the execution environment, silently dropping the dispatch.
  try {
    await fetch(`${siteUrl}/.netlify/functions/linear-triage-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.data),
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { source: 'linear-webhook' } });
  }

  return { statusCode: 200, body: 'OK' };
}
