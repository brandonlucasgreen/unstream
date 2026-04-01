// One-time script to register the /unstream slash command with Discord.
// Run with: DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... npx tsx scripts/discord-register-commands.ts

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;

if (!DISCORD_BOT_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error('Missing DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID environment variables.');
  process.exit(1);
}

async function registerCommands() {
  const response = await fetch(
    `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
      body: JSON.stringify([
        {
          name: 'unstream',
          description: 'Find an artist on alternative, artist-friendly music platforms',
          options: [
            {
              name: 'artist',
              description: 'Artist name to search for',
              type: 3, // STRING
              required: true,
            },
          ],
        },
        {
          name: 'Lookup on Unstream',
          type: 3, // MESSAGE command (context menu)
        },
      ]),
    }
  );

  if (!response.ok) {
    console.error(`Failed to register commands: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.error(text);
    process.exit(1);
  }

  const data = await response.json();
  console.log('Registered commands:', JSON.stringify(data, null, 2));
}

registerCommands().catch(console.error);
