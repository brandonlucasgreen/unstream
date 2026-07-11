// POST /api/agentmail-webhook
// AgentMail inbound-email webhook — verifies the Svix signature and dispatches
// message.received events to a background function for Claude Code triage.
// See https://www.agentmail.to/docs/webhooks-overview

import { Webhook } from 'svix';
import { Sentry } from '../lib/sentry';

const AGENTMAIL_WEBHOOK_SECRET = process.env.AGENTMAIL_WEBHOOK_SECRET || '';

interface AgentMailWebhookPayload {
  event_type: string;
  event_id: string;
  message?: {
    message_id: string;
    thread_id: string;
    inbox_id: string;
    from_: string[];
    to?: string[];
    subject?: string;
    text?: string;
    html?: string;
  };
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

  if (!AGENTMAIL_WEBHOOK_SECRET) {
    Sentry.captureMessage('agentmail-webhook: AGENTMAIL_WEBHOOK_SECRET not configured', { level: 'error' });
    return { statusCode: 500, body: 'Not configured' };
  }

  const svixHeaders = {
    'svix-id': event.headers['svix-id'] || '',
    'svix-timestamp': event.headers['svix-timestamp'] || '',
    'svix-signature': event.headers['svix-signature'] || '',
  };

  let payload: AgentMailWebhookPayload;
  try {
    const wh = new Webhook(AGENTMAIL_WEBHOOK_SECRET);
    payload = wh.verify(event.body, svixHeaders) as AgentMailWebhookPayload;
  } catch (_error) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  if (payload.event_type !== 'message.received' || !payload.message) {
    // Acknowledge other event types without acting on them.
    return { statusCode: 200, body: 'Ignored' };
  }

  const siteUrl = process.env.URL || 'https://unstream.stream';

  // Fire-and-forget dispatch — respond fast so AgentMail doesn't retry the delivery.
  fetch(`${siteUrl}/.netlify/functions/agentmail-triage-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload.message),
  }).catch((error) => {
    Sentry.captureException(error, { tags: { source: 'agentmail-webhook' } });
  });

  return { statusCode: 200, body: 'OK' };
}
