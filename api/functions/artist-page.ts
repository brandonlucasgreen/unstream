// API endpoint: GET /api/artist-page?slug=...
// Returns an artist's page payload as JSON — the rich profile for a claimed artist, the links
// and releases for an unclaimed one.
// This is the data source for the React SPA artist page (UNS-102).

import { getArtistProfileBySlug, getArtistReleases } from './db';
import { checkRateLimit, checkSentryDedup, getClientIp } from './ratelimit';
import { Sentry } from '../lib/sentry';
import { isPublishedArtistSlug } from '../shared/published-artist-slugs';
import { PLATFORMS } from '../shared/platform-registry';
import { isBandcampFriday } from '../shared/bandcamp-friday';
import { mainLinkDividerIndexes } from '../shared/link-dividers';
import { sanitizeEmbed } from './artist-profile';

const CORS_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function handler(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string>; httpMethod?: string }) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  const slug = event.queryStringParameters?.slug;

  if (!slug) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'slug parameter is required' }),
    };
  }

  try {
    const { bundle, failed } = await getArtistProfileBySlug(slug);

    // The lookup itself broke. Say so with a 503 instead of claiming the artist doesn't exist —
    // a Supabase outage would otherwise render as every artist page 404ing convincingly.
    if (failed) {
      Sentry.captureMessage('[artist-page] artist lookup failed', {
        level: 'error',
        tags: { slug },
        extra: { context: 'artist-page.lookupFailed' },
      });
      return {
        statusCode: 503,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'Artist lookup temporarily unavailable' }),
      };
    }

    if (!bundle) {
      // A 404 for a slug we publish in data/artists-manifest.json is our bug: that manifest feeds
      // the sitemap and the social posts, so the URL is one we've handed out. A 404 for anything
      // else is just a fan or a crawler guessing, and reporting those would bury the real signal.
      //
      // Deduped per slug for 24h. That bound matters right now: at the time of writing only 55 of
      // the 791 published slugs have an `artists` row, so this fires for the rest until that gap is
      // closed (populate the rows, or stop publishing slugs with no data). One event per slug per
      // day keeps that backlog readable instead of one per request.
      if (isPublishedArtistSlug(slug) && await checkSentryDedup(`artist-page-404:${slug}`, 86400)) {
        Sentry.captureMessage('[artist-page] 404 for a published artist slug', {
          level: 'warning',
          tags: { slug },
          extra: { context: 'artist-page.publishedSlug404' },
        });
      }
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Artist not found' }),
      };
    }

    const { artist: artistRow, profile, links: rawLinks } = bundle;

    // Filter out junk links (same logic as the edge function)
    const allLinks = rawLinks.filter(l => {
      const u = l.url.toLowerCase();
      return !u.includes('duckduckgo.com')
        && !u.includes('google.com/search')
        && !u.includes('searchstyle=search');
    });

    const bcFriday = isBandcampFriday();

    // Split links into main (non-social) and social
    const isMainLink = (l: { platform: string }) => {
      const info = PLATFORMS[l.platform];
      return !info || info.category !== 'social';
    };
    const mainLinks = allLinks.filter(isMainLink);
    const socialLinks = allLinks.filter(l => {
      const info = PLATFORMS[l.platform];
      return info?.category === 'social';
    });

    // Build the main links array with payout info
    const links = mainLinks.map(l => {
      const info = PLATFORMS[l.platform];
      const isBCFriday = l.platform === 'bandcamp' && bcFriday;
      const payoutPercent = isBCFriday ? '~97%' : (info?.payoutPercent ?? null);
      const displayName = (l.platform === 'other' || l.platform.startsWith('other_'))
        ? (l.display_name || null)
        : (l.display_name || info?.name || null);

      return {
        platform: l.platform,
        url: l.url,
        displayName,
        payoutPercent,
        bandcampFriday: isBCFriday,
      };
    });

    // Build the social links array
    const social = socialLinks.map(l => {
      const info = PLATFORMS[l.platform];
      return {
        platform: l.platform,
        url: l.url,
        displayName: l.display_name || info?.name || null,
      };
    });

    // Same claimed test the artist-page-static edge function applies, so the two renderers of
    // this URL agree on which card a fan sees: a profile row alone isn't enough, the artist row
    // has to be claimed too.
    const isClaimed = artistRow.match_confidence === 'claimed' && !!profile?.verified_at;

    // Sanitize the featured embed
    const featuredEmbed = sanitizeEmbed(profile?.featured_embed ?? null);

    // Build the image URL: custom > artist row > null
    const imageUrl = (isClaimed && profile?.custom_image_url) || artistRow.image_url || null;

    // Releases. The page paginates these ten at a time rather than listing them all, so the cap
    // here bounds the payload, not what a fan can reach: six pages, which covers every catalogue
    // measured so far (16 for Sufjan Stevens, 13 for Explosions in the Sky, 33 for the largest
    // live Mirlo artist). Beyond it the list says how many more exist rather than fetching them.
    const { releases, total: releaseCount } = await getArtistReleases(artistRow.id, 60);

    const payload = {
      artist: {
        id: artistRow.id,
        slug: artistRow.slug,
        name: artistRow.name,
        imageUrl,
        matchConfidence: artistRow.match_confidence as 'verified' | 'unverified' | 'claimed',
        country: artistRow.country,
        countryCode: artistRow.country_code,
        city: artistRow.city,
      },
      profile: profile ? {
        bio: profile.bio,
        customImageUrl: profile.custom_image_url,
        featuredEmbed,
        // The SPA picks RichArtistProfile vs UnclaimedQuietCard off this field.
        verifiedAt: isClaimed ? profile.verified_at : null,
      } : null,
      links,
      // Indexes into `links` above which a horizontal divider is drawn.
      linkDividers: mainLinkDividerIndexes(allLinks, isMainLink, profile?.link_dividers),
      socialLinks: social,
      releases,
      releaseCount,
      bandcampFriday: bcFriday,
    };

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 's-maxage=300, stale-while-revalidate=86400',
        'Cache-Tag': `artist-page-${slug}`,
      },
      body: JSON.stringify(payload),
    };
  } catch (error) {
    console.error('[artist-page] Error:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}