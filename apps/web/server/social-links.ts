import type { SocialPlatform, SocialLink } from './shared-types';
import { fetchWithTimeout } from './shared-utils';

// Parse a URL to determine which social platform it belongs to
export function parseSocialUrl(url: string): SocialLink | null {
  const urlLower = url.toLowerCase();

  if (urlLower.includes('instagram.com')) return { platform: 'instagram', url };
  if (urlLower.includes('facebook.com')) return { platform: 'facebook', url };
  if (urlLower.includes('tiktok.com')) return { platform: 'tiktok', url };
  if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) return { platform: 'youtube', url };
  if (urlLower.includes('threads.net') || urlLower.includes('threads.com')) return { platform: 'threads', url };
  if (urlLower.includes('bsky.app') || urlLower.includes('bluesky')) return { platform: 'bluesky', url };
  if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) return { platform: 'twitter', url };

  return null;
}

// Extract Discogs artist ID from URL (e.g., https://www.discogs.com/artist/3840 -> 3840)
export function extractDiscogsArtistId(discogsUrl: string): string | null {
  const match = discogsUrl.match(/\/artist\/(\d+)/);
  return match ? match[1] : null;
}

export async function fetchDiscogsSocialLinks(discogsUrl: string): Promise<SocialLink[]> {
  const socialLinks: SocialLink[] = [];
  const artistId = extractDiscogsArtistId(discogsUrl);

  if (!artistId) return socialLinks;

  try {
    const response = await globalThis.fetch(`https://api.discogs.com/artists/${artistId}`, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://unstream.stream - ethical music finder)',
      },
    });

    if (!response.ok) {
      console.log('Discogs API failed:', response.status);
      return socialLinks;
    }

    const data = await response.json() as { urls?: string[] };
    const urls = data.urls || [];

    for (const url of urls) {
      const socialLink = parseSocialUrl(url);
      if (socialLink) {
        socialLinks.push(socialLink);
      }
    }
  } catch (error: any) {
    console.error('Discogs fetch error:', error.message);
  }

  return socialLinks;
}

export async function fetchOfficialSiteSocialLinks(officialUrl: string): Promise<SocialLink[]> {
  const socialLinks: SocialLink[] = [];
  const seenPlatforms = new Set<SocialPlatform>();

  try {
    const response = await fetchWithTimeout(officialUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) {
      console.log('Official site fetch failed:', response.status);
      return socialLinks;
    }

    const html = await response.text();
    const hrefMatches = html.matchAll(/href=["']([^"']+)["']/gi);

    for (const match of hrefMatches) {
      const url = match[1];
      if (!url.startsWith('http')) continue;

      const socialLink = parseSocialUrl(url);
      if (socialLink && !seenPlatforms.has(socialLink.platform)) {
        seenPlatforms.add(socialLink.platform);
        socialLinks.push(socialLink);
      }
    }
  } catch (error: any) {
    console.error('Official site fetch error:', error.message);
  }

  return socialLinks;
}

// Merge social links from multiple sources, deduplicating by platform (first source wins per platform)
export function mergeSocialLinks(...linkArrays: SocialLink[][]): SocialLink[] {
  const seenPlatforms = new Set<SocialPlatform>();
  const merged: SocialLink[] = [];

  for (const links of linkArrays) {
    for (const link of links) {
      if (!seenPlatforms.has(link.platform)) {
        seenPlatforms.add(link.platform);
        merged.push(link);
      }
    }
  }

  return merged;
}
