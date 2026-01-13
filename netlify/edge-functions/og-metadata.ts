import { Context } from "https://edge.netlify.com";

// Social media crawler user agents
const CRAWLER_USER_AGENTS = [
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
  'Googlebot',
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

// Check if request is from a social media crawler
function isCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return CRAWLER_USER_AGENTS.some(crawler => ua.includes(crawler.toLowerCase()));
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

// Generate HTML with OG meta tags
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

  <!-- Redirect to actual app for browsers that render this -->
  <meta http-equiv="refresh" content="0;url=/?q=${encodeURIComponent(query)}">
</head>
<body>
  <p>Redirecting to Unstream...</p>
</body>
</html>`;
}

export default async function handler(request: Request, context: Context) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  const userAgent = request.headers.get('user-agent');

  // Only intercept if:
  // 1. This is the root path (or index)
  // 2. There's a ?q= parameter
  // 3. Request is from a social media crawler
  if (!query || !isCrawler(userAgent)) {
    // Pass through to normal app
    return context.next();
  }

  // For crawlers, fetch artist info and return OG-enriched HTML
  const baseUrl = `${url.protocol}//${url.host}`;
  const { imageUrl, artistName } = await getFirstArtistImage(query, baseUrl);

  const html = generateOgHtml(query, imageUrl, artistName);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
    },
  });
}

export const config = {
  path: "/",
};
