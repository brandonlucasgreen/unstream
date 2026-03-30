// Netlify Background Function (the `-background` suffix makes it async).
// Receives artist search request from discord-interaction, calls the search API,
// formats results as a Discord embed, and PATCHes the followup message.

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

// Platform metadata for embed formatting
const PLATFORM_INFO: Record<string, { name: string; emoji: string; category: string; payout?: string }> = {
  bandcamp: { name: 'Bandcamp', emoji: '\u{1F3B5}', category: 'Music Marketplaces', payout: '80-85%' },
  mirlo: { name: 'Mirlo', emoji: '\u{1FABA}', category: 'Music Marketplaces', payout: '86-90%' },
  ampwall: { name: 'Ampwall', emoji: '\u{1F50A}', category: 'Music Marketplaces', payout: '85-90%' },
  qobuz: { name: 'Qobuz', emoji: '\u{1F4BF}', category: 'Music Marketplaces', payout: '~70%' },
  beatport: { name: 'Beatport', emoji: '\u{1F39B}\uFE0F', category: 'Music Marketplaces', payout: '55-70%' },
  jamcoop: { name: 'Jam.coop', emoji: '\u{1F3B8}', category: 'Music Marketplaces', payout: '86-95%' },
  discogs: { name: 'Discogs', emoji: '\u{1F4BF}', category: 'Music Marketplaces' },
  faircamp: { name: 'Faircamp', emoji: '\u26FA', category: 'Decentralized', payout: '90-100%' },
  bandwagon: { name: 'Bandwagon', emoji: '\u{1F690}', category: 'Decentralized', payout: '90-100%' },
  patreon: { name: 'Patreon', emoji: '\u{1F3A8}', category: 'Patronage', payout: '86-90%' },
  buymeacoffee: { name: 'Buy Me a Coffee', emoji: '\u2615', category: 'Patronage', payout: '95-97%' },
  kofi: { name: 'Ko-fi', emoji: '\u{1F375}', category: 'Patronage', payout: '92-97%' },
  hoopla: { name: 'Hoopla', emoji: '\u{1F4DA}', category: 'Library Services' },
  freegal: { name: 'Freegal', emoji: '\u{1F3B5}', category: 'Library Services' },
};

interface PlatformHit {
  sourceId: string;
  url: string;
}

interface SearchResult {
  name?: string;
  imageUrl?: string;
  platforms?: PlatformHit[];
}

interface SearchResponse {
  results?: SearchResult[];
}

interface DiscordEmbed {
  title: string;
  description: string;
  url?: string;
  color: number;
  fields?: { name: string; value: string; inline: boolean }[];
  footer?: { text: string };
  thumbnail?: { url: string };
}

export async function handler(event: { body: string | null }) {
  if (!event.body) return { statusCode: 400 };

  const { interaction_token, application_id, artist_name, resolve_url } = JSON.parse(event.body) as {
    interaction_token: string;
    application_id: string;
    artist_name?: string;
    resolve_url?: string;
  };

  const webhookUrl = `https://discord.com/api/v10/webhooks/${application_id}/${interaction_token}/messages/@original`;
  const siteUrl = process.env.URL || 'https://unstream.stream';

  try {
    // Resolve URL to artist name if needed
    let resolvedArtistName = artist_name;

    if (resolve_url) {
      const resolveResponse = await fetch(
        `${siteUrl}/api/resolve/url?url=${encodeURIComponent(resolve_url)}`
      );
      if (!resolveResponse.ok) {
        await fetch(webhookUrl, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          },
          body: JSON.stringify({
            embeds: [
              {
                title: 'Could not resolve link',
                description: "Couldn't identify the artist from that link. Try searching on [unstream.stream](https://unstream.stream).",
                color: 0xEF4444,
              },
            ],
          }),
        });
        return { statusCode: 200 };
      }
      const resolveData = (await resolveResponse.json()) as { artist_name?: string };
      if (!resolveData.artist_name) {
        await fetch(webhookUrl, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          },
          body: JSON.stringify({
            embeds: [
              {
                title: 'Could not resolve link',
                description: "Couldn't identify the artist from that link. Try searching on [unstream.stream](https://unstream.stream).",
                color: 0xEF4444,
              },
            ],
          }),
        });
        return { statusCode: 200 };
      }
      resolvedArtistName = resolveData.artist_name;
    }

    if (!resolvedArtistName) {
      return { statusCode: 400 };
    }

    // Call search API
    const searchResponse = await fetch(
      `${siteUrl}/api/search/sources?query=${encodeURIComponent(resolvedArtistName)}`
    );
    const searchData: SearchResponse = await searchResponse.json();

    let embed: DiscordEmbed;
    if (searchData.results && searchData.results.length > 0) {
      const topResult = searchData.results[0];

      // Group platforms by category
      const categories: Record<string, string[]> = {};
      for (const platform of topResult.platforms || []) {
        const info = PLATFORM_INFO[platform.sourceId];
        if (!info) continue;
        if (!categories[info.category]) categories[info.category] = [];
        const payoutStr = info.payout ? ` \u00B7 ${info.payout}` : '';
        categories[info.category].push(
          `${info.emoji} [${info.name}](${platform.url})${payoutStr}`
        );
      }

      const fields = Object.entries(categories).map(([category, links]) => ({
        name: category,
        value: links.join('\n'),
        inline: false,
      }));

      const platformCount = (topResult.platforms || []).length;
      embed = {
        title: topResult.name || resolvedArtistName,
        description: `Found on ${platformCount} alternative platform${platformCount !== 1 ? 's' : ''}`,
        url: `https://unstream.stream/?q=${encodeURIComponent(resolvedArtistName)}`,
        color: 0x8B5CF6, // Purple accent
        fields,
        footer: { text: 'Unstream \u00B7 Support artists directly \u00B7 unstream.stream' },
      };

      if (topResult.imageUrl) {
        (embed as DiscordEmbed & { thumbnail: { url: string } }).thumbnail = { url: topResult.imageUrl };
      }
    } else {
      embed = {
        title: 'No results found',
        description: `No alternative platforms found for "${resolvedArtistName}". Try searching on [unstream.stream](https://unstream.stream).`,
        color: 0xEF4444,
      };
    }

    // Send followup message by editing the deferred response
    await fetch(webhookUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (_error) {
    // Send error followup
    await fetch(webhookUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        embeds: [
          {
            title: 'Search failed',
            description:
              'Something went wrong. Try searching on [unstream.stream](https://unstream.stream).',
            color: 0xEF4444,
          },
        ],
      }),
    }).catch(() => {});
  }

  return { statusCode: 200 };
}
