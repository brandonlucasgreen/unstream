import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse } from 'node-html-parser';

// Site configurations for DuckDuckGo site-specific searches
const SITE_CONFIGS: Record<string, { domain: string; extractUrl?: (href: string) => string | null }> = {
  hoopla: {
    domain: 'hoopladigital.com',
    extractUrl: (href) => {
      // Hoopla URLs look like: /album/12345 or /artist/12345
      if (href.includes('hoopladigital.com')) return href;
      return null;
    }
  },
  kofi: {
    domain: 'ko-fi.com',
    extractUrl: (href) => {
      // Ko-fi creator pages: ko-fi.com/username
      if (href.includes('ko-fi.com') && !href.includes('/post/') && !href.includes('/shop/')) {
        return href;
      }
      return null;
    }
  },
  buymeacoffee: {
    domain: 'buymeacoffee.com',
    extractUrl: (href) => {
      // BMC creator pages: buymeacoffee.com/username
      if (href.includes('buymeacoffee.com') && !href.includes('/post/')) {
        return href;
      }
      return null;
    }
  },
  patreon: {
    domain: 'patreon.com',
    extractUrl: (href) => {
      // Patreon creator pages: patreon.com/username
      if (href.includes('patreon.com') && !href.includes('/posts/')) {
        return href;
      }
      return null;
    }
  },
  faircamp: {
    domain: 'faircamp',
    // Faircamp sites can be on any domain but contain 'faircamp' in URLs or meta
  },
};

interface SiteSearchResult {
  found: boolean;
  url?: string;
  title?: string;
}

async function searchDuckDuckGo(query: string, site: string): Promise<SiteSearchResult> {
  const config = SITE_CONFIGS[site];
  if (!config) {
    return { found: false };
  }

  const searchQuery = `site:${config.domain} ${query}`;
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;

  try {
    const response = await fetch(ddgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Unstream/1.0; +https://github.com/unstream)',
      },
    });

    if (!response.ok) {
      console.error(`DuckDuckGo request failed: ${response.status}`);
      return { found: false };
    }

    const html = await response.text();
    const root = parse(html);

    // Find result links - DuckDuckGo HTML results have class "result__a"
    const resultLinks = root.querySelectorAll('.result__a');

    if (resultLinks.length === 0) {
      // Also check for result__url as backup
      const resultUrls = root.querySelectorAll('.result__url');
      if (resultUrls.length === 0) {
        return { found: false };
      }
    }

    // Get the first result
    const firstResult = resultLinks[0];
    if (!firstResult) {
      return { found: false };
    }

    let href = firstResult.getAttribute('href') || '';
    const title = firstResult.textContent?.trim() || '';

    // DuckDuckGo HTML results use redirect URLs, extract the actual URL
    if (href.includes('uddg=')) {
      const urlMatch = href.match(/uddg=([^&]+)/);
      if (urlMatch) {
        href = decodeURIComponent(urlMatch[1]);
      }
    }

    // Validate the URL matches our target site
    if (!href.includes(config.domain)) {
      return { found: false };
    }

    // Apply custom URL extraction if defined
    if (config.extractUrl) {
      const extractedUrl = config.extractUrl(href);
      if (!extractedUrl) {
        return { found: false };
      }
      href = extractedUrl;
    }

    return {
      found: true,
      url: href,
      title,
    };
  } catch (error) {
    console.error(`Site search error for ${site}:`, error);
    return { found: false };
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { query, site } = req.query;

  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'Query parameter is required' });
    return;
  }

  if (!site || typeof site !== 'string') {
    res.status(400).json({ error: 'Site parameter is required' });
    return;
  }

  if (!SITE_CONFIGS[site]) {
    res.status(400).json({
      error: `Invalid site. Valid options: ${Object.keys(SITE_CONFIGS).join(', ')}`
    });
    return;
  }

  const result = await searchDuckDuckGo(query, site);

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

  res.status(200).json(result);
}
