import { Context } from "https://edge.netlify.com";

// Social media crawler user agents (for OG tag previews only)
const SOCIAL_CRAWLER_USER_AGENTS = [
  'facebookexternalhit',
  'Facebot',
  'Twitterbot',
  'LinkedInBot',
  'Pinterest',
  'Slackbot',
  'TelegramBot',
  'WhatsApp',
  'Discordbot',
  'Applebot',
  'Mastodon',
  'Pleroma',
  'Misskey',
  'Akkoma',
  'Pixelfed',
  'PeerTube',
  'Lemmy',
  'Bluesky',
  'bsky.app',
  'redditbot',
];

// Indexing crawlers (need actual page content, not just OG tags)
const INDEXING_CRAWLERS = [
  'Googlebot',
  'bingbot',
  'YandexBot',
  'DuckDuckBot',
  'Baiduspider',
];

// Check if request is from a social media crawler (OG previews only)
function isSocialCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return SOCIAL_CRAWLER_USER_AGENTS.some(crawler => ua.includes(crawler.toLowerCase()));
}

// Check if request is from an indexing crawler (needs real page content)
function isIndexingCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return INDEXING_CRAWLERS.some(crawler => ua.includes(crawler.toLowerCase()));
}

// Perform search to get first artist image
async function getFirstArtistImage(query: string, baseUrl: string): Promise<{ imageUrl?: string; artistName?: string }> {
  try {
    const searchUrl = new URL('/api/search/sources', baseUrl);
    searchUrl.searchParams.set('query', query);

    const response = await fetch(searchUrl.toString(), {
      headers: {
        'User-Agent': 'Unstream OG Metadata Fetcher',
      },
    });

    if (!response.ok) return {};

    const data = await response.json();
    const results = data.results || [];

    if (results.length > 0) {
      const firstResult = results[0];
      return {
        imageUrl: firstResult.imageUrl,
        artistName: firstResult.name,
      };
    }

    return {};
  } catch (error) {
    console.error('Error fetching artist image:', error);
    return {};
  }
}

// Generate HTML with OG meta tags (no meta refresh — crawlers read OG tags directly)
function generateOgHtml(query: string, imageUrl?: string, artistName?: string): string {
  const displayName = artistName || query;
  const title = `${displayName} on Unstream - Find music on alternative platforms`;
  const description = `Find ${displayName} on Bandcamp, Qobuz, and other ethical music platforms. Support artists directly.`;
  // Use artist image if available, otherwise no image (let platform use default)
  const ogImage = imageUrl || '';

  const imageMetaTags = ogImage ? `
  <meta property="og:image" content="${ogImage}">
  <meta name="twitter:image" content="${ogImage}">` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>

  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://unstream.stream/?q=${encodeURIComponent(query)}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">${imageMetaTags}

  <!-- Twitter -->
  <meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:url" content="https://unstream.stream/?q=${encodeURIComponent(query)}">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
</head>
<body>
  <p>Unstream — find music on platforms that pay artists fairly.</p>
</body>
</html>`;
}

export default async function handler(request: Request, context: Context) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  const userAgent = request.headers.get('user-agent');

  if (!query) {
    // No search query — pass through to normal app
    return context.next();
  }

  // For indexing crawlers (Googlebot, bingbot): pass through to SPA
  // Previously, meta http-equiv="refresh" caused Google to report redirect errors.
  // Indexing crawlers need the actual page content to index, not just OG tags.
  if (isIndexingCrawler(userAgent)) {
    return context.next();
  }

  // For social media crawlers: return OG-enriched HTML without meta refresh
  if (isSocialCrawler(userAgent)) {
    const baseUrl = `${url.protocol}//${url.host}`;
    const { imageUrl, artistName } = await getFirstArtistImage(query, baseUrl);
    const html = generateOgHtml(query, imageUrl, artistName);

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // For regular browsers: pass through to SPA app (client-side routing handles ?q= natively)
  return context.next();
}

export const config = {
  path: "/",
};
