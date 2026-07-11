// One-time script to register the message.received webhook with AgentMail.
// Run with:
//   AGENTMAIL_API_KEY=... npx tsx scripts/agentmail-register-webhook.ts
//
// Optional: AGENTMAIL_INBOX_ID=... to scope the webhook to a single inbox
// (omit to receive events from every inbox on the account).
//
// Prints the returned signing secret — set that as AGENTMAIL_WEBHOOK_SECRET
// in Netlify (see api/functions/agentmail-webhook.ts).

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY;
const AGENTMAIL_INBOX_ID = process.env.AGENTMAIL_INBOX_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://unstream.stream/api/agentmail-webhook';

if (!AGENTMAIL_API_KEY) {
  console.error('Missing AGENTMAIL_API_KEY environment variable.');
  process.exit(1);
}

async function registerWebhook() {
  const body: { url: string; event_types: string[]; inbox_ids?: string[] } = {
    url: WEBHOOK_URL,
    event_types: ['message.received'],
  };
  if (AGENTMAIL_INBOX_ID) {
    body.inbox_ids = [AGENTMAIL_INBOX_ID];
  }

  const response = await fetch('https://api.agentmail.to/v0/webhooks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AGENTMAIL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error(`Failed to register webhook: ${response.status} ${response.statusText}`);
    console.error(await response.text());
    process.exit(1);
  }

  const data = await response.json();
  console.log('Webhook registered:', JSON.stringify(data, null, 2));
  console.log('\nSet this as AGENTMAIL_WEBHOOK_SECRET in Netlify:');
  console.log(data.secret);
}

registerWebhook().catch(console.error);
