// One-time script to register the Issue-create webhook with Linear.
// Run with:
//   LINEAR_API_KEY=... npx tsx scripts/linear-register-webhook.ts
//
// Optional: LINEAR_TEAM_ID=... to scope the webhook to a single team
// (omit to receive Issue events from every team in the workspace).
//
// Requires a workspace-admin personal API key, or an OAuth app token with
// the `admin` scope — per Linear's docs, only admins can create webhooks.
//
// Prints the returned signing secret — set that as LINEAR_WEBHOOK_SECRET
// in Netlify (see api/functions/linear-webhook.ts).

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://unstream.stream/api/linear-webhook';

if (!LINEAR_API_KEY) {
  console.error('Missing LINEAR_API_KEY environment variable.');
  process.exit(1);
}

async function registerWebhook() {
  const input: { url: string; resourceTypes: string[]; teamId?: string } = {
    url: WEBHOOK_URL,
    resourceTypes: ['Issue'],
  };
  if (LINEAR_TEAM_ID) {
    input.teamId = LINEAR_TEAM_ID;
  }

  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({
      query: `
        mutation WebhookCreate($input: WebhookCreateInput!) {
          webhookCreate(input: $input) {
            success
            webhook { id url enabled secret resourceTypes }
          }
        }
      `,
      variables: { input },
    }),
  });

  const result = await response.json();

  if (!response.ok || result.errors) {
    console.error(`Failed to register webhook: ${response.status}`);
    console.error(JSON.stringify(result.errors || result, null, 2));
    process.exit(1);
  }

  const webhook = result.data?.webhookCreate?.webhook;
  console.log('Webhook registered:', JSON.stringify(webhook, null, 2));
  console.log('\nSet this as LINEAR_WEBHOOK_SECRET in Netlify:');
  console.log(webhook.secret);
}

registerWebhook().catch(console.error);
