import type { Context } from "https://edge.netlify.com";
import { isSocialCrawler, isIndexingCrawler } from "../shared/crawler-detection.ts";

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

// Edge functions run on Deno and can't import from api/functions, so each keeps its own copy.
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Generate HTML with OG meta tags (no meta refresh — crawlers read OG tags directly).
// The query comes from the URL and the name and image from a search result, so all three
// are escaped before they reach the page. Exported for the test.
export function generateOgHtml(query: string, imageUrl?: string, artistName?: string): string {
  const displayName = artistName || query;
  const title = escapeHtml(`${displayName} on Unstream - Find music on alternative platforms`);
  const description = escapeHtml(`Find ${displayName} on Bandcamp, Qobuz, and other ethical music platforms. Support artists directly.`);
  // encodeURIComponent leaves ' alone, so the URL is escaped for the attribute too.
  const pageUrl = escapeHtml(`https://unstream.stream/?q=${encodeURIComponent(query)}`);
  // Use artist image if available, otherwise no image (let platform use default)
  const ogImage = imageUrl ? escapeHtml(imageUrl) : '';

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
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">${imageMetaTags}

  <!-- Twitter -->
  <meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:url" content="${pageUrl}">
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
