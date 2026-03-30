// POST /api/discord/interaction
// Discord Interaction Endpoint — receives slash commands, verifies Ed25519 signature,
// and dispatches background search via Netlify Background Function.

import nacl from 'tweetnacl';

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';

interface DiscordOption {
  name: string;
  value: string;
  type: number;
}

interface DiscordInteraction {
  type: number;
  token: string;
  application_id: string;
  data?: {
    name: string;
    options?: DiscordOption[];
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

  // Verify Ed25519 signature (required by Discord)
  const signature = event.headers['x-signature-ed25519'];
  const timestamp = event.headers['x-signature-timestamp'];
  if (!signature || !timestamp || !event.body) {
    return { statusCode: 401, body: 'Invalid request' };
  }

  const isVerified = nacl.sign.detached.verify(
    Buffer.from(timestamp + event.body),
    Buffer.from(signature, 'hex'),
    Buffer.from(DISCORD_PUBLIC_KEY, 'hex')
  );
  if (!isVerified) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const body: DiscordInteraction = JSON.parse(event.body);

  // PING — Discord sends this to validate the endpoint
  if (body.type === 1) {
    return {
      statusCode: 200,
      body: JSON.stringify({ type: 1 }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  // APPLICATION_COMMAND — slash command invocation
  if (body.type === 2) {
    const artistName = body.data?.options?.find((o) => o.name === 'artist')?.value;
    if (!artistName) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          type: 4,
          data: { content: 'Please provide an artist name.', flags: 64 },
        }),
        headers: { 'Content-Type': 'application/json' },
      };
    }

    // Fire off background search (fire-and-forget)
    const siteUrl = process.env.URL || 'https://unstream.stream';
    fetch(`${siteUrl}/.netlify/functions/discord-search-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_token: body.token,
        application_id: body.application_id,
        artist_name: artistName,
      }),
    }).catch(() => {});

    // Return deferred response (type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
    return {
      statusCode: 200,
      body: JSON.stringify({ type: 5 }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  return { statusCode: 400, body: 'Unknown interaction type' };
}
