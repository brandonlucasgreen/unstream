// API endpoint: GET /api/artist-page?slug=...
// Returns an artist's page payload as JSON — the rich profile for a claimed artist, the links
// and releases for an unclaimed one.
// This is the data source for the React SPA artist page (UNS-102).

import { getArtistProfileBySlug, getArtistReleases, getClient, resolveArtistSlugAlias } from './db';
import { checkRateLimit, checkSentryDedup, getClientIp } from './ratelimit';
import { Sentry, withSentry } from '../lib/sentry';
import { isPublishedArtistSlug } from '../shared/published-artist-slugs';
import { PLATFORMS } from '../shared/platform-registry';
import { isBandcampFriday } from '../shared/bandcamp-friday';
import { leadingOfferSummary, orderedSourcePlatforms } from '../shared/release-display';
import { mainLinkDividerIndexes } from '../shared/link-dividers';
import { sanitizeEmbed } from './artist-profile';
import { getGoals, getTipsLiveSlugs } from './tips-db';
import { getFeatureFlag } from './feature-flags';
import { groupLinksIntoSections, resolveSectionOrder, type PageSectionKey } from '../shared/page-sections';

const CORS_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function handleRequest(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string>; httpMethod?: string }) {
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
    let { bundle, failed } = await getArtistProfileBySlug(slug);

    // A retired slug still resolves: the artist was merged into another row, or re-slugged when
    // accent folding was fixed (`trentem-ller` -> `trentemoller`). Only on a miss, so a live slug
    // always wins and the normal path pays nothing; and never after `failed`, because an outage is
    // not evidence that a slug was retired.
    //
    // This endpoint is why the alias table exists and was somehow the one caller that never
    // consulted it. It shipped in #272, before the aliases of #410, so the accent-folding fix
    // re-slugged five artists we publish and left every human following their old URL on the
    // not-found card while crawlers got a clean 301 from artist-page-static. Adding a URL-serving
    // reader of `artists.slug` means adding it here too.
    if (!bundle && !failed) {
      const { canonical, failed: aliasFailed } = await resolveArtistSlugAlias(slug);
      // The alias lookup breaking is an outage too, not evidence the slug is gone — same 503
      // as the branch below, never a 404 that reads as "this artist doesn't exist".
      if (aliasFailed) {
        failed = true;
      } else if (canonical) {
        ({ bundle, failed } = await getArtistProfileBySlug(canonical));
      }
    }

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

    // Build the sectioned link payload (UNS-221). One pass over the artist's ordered links:
    // every link lands in its section (patronage / marketplaces / official / social) by way of
    // the platform registry's sectionCategory — a platform the registry doesn't know rides in
    // `marketplaces`, never dropped — and the artist's stored dividers become per-section
    // rules. This replaces the old two-bucket split (main links + social): the same links,
    // grouped the way the page now renders them, so the SPA can draw section headings in the
    // artist's own section order without re-deriving any of it client-side.
    const categoryOf = (l: { platform: string }) => PLATFORMS[l.platform]?.sectionCategory;
    const linkGroups = groupLinksIntoSections(allLinks, categoryOf, profile?.link_dividers).map(group => ({
      section: group.key,
      links: group.items.map(l => {
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
      }),
      // Divider positions, reindexed into this section's own link list (dividers the artist
      // placed between sections that are now separately grouped ride along here rather than
      // disappearing — a rule with one link on each side of a section boundary still draws).
      dividerIndexes: group.ruleIndexes,
    }));

    // The artist's saved section order, defaulting to patronage → bio → featured →
    // marketplaces → social. `official` is not artist-orderable and follows marketplaces
    // wherever that lands (see api/shared/page-sections.ts).
    const sectionOrder: PageSectionKey[] = resolveSectionOrder(profile?.section_order);

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
    // Whether the artist takes tips, read alongside the releases. A failed read shows no Tip
    // button (reported inside getTipsLiveSlugs) rather than failing the page.
    //
    // UNS-215: the fan-facing tips flag (tipsFans) gates this payload too — an artist may be
    // onboarded with Stripe while fans are not yet allowed to tip. Off — or unreadable, since the
    // flag store fails closed — renders `tips: { enabled: false, goals: [] }` and skips the tips
    // query entirely. The flag read rides along with the releases read rather than costing its own
    // round trip, and hiding tips never fails the rest of the page.
    const [{ releases, total: releaseCount }, tipsFlagOn] = await Promise.all([
      getArtistReleases(artistRow.id, 60),
      getFeatureFlag('tipsFans'),
    ]);
    const tipsLive = tipsFlagOn ? await getTipsLiveSlugs([artistRow.slug]) : null;
    const tipsEnabled = tipsLive?.has(artistRow.slug) ?? false;
    const goals = tipsEnabled ? await readOpenGoals(artistRow.id) : [];

    // "from $8 · ≈$6.80 to artist", and the platforms ordered artist-paying-first.
    //
    // Computed here rather than shipped as raw offers for the client to price up, for the same
    // reason `/api/release` computes `payoutPercent` server-side: the payout figures live in the
    // registry, and every hand-kept copy of them is a drift risk (the Discord bot quoted an
    // unsourced Jam.coop rate for months from exactly such a copy). The web page can already do
    // this arithmetic from its own mirror of the registry; the Mac app and the extension cannot,
    // and shouldn't learn to.
    //
    // Same two fields, same names, as a release alert from `check-releases` — a release row
    // should read identically wherever a client renders one.
    const releasesWithSummary = releases.map(release => ({
      ...release,
      offerSummary: leadingOfferSummary(release.sources),
      platforms: orderedSourcePlatforms(release.sources),
    }));

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
      // UNS-221 sectioned links, in the artist's own order. Legacy `links` + `socialLinks`
      // stay on the payload in parallel for clients that haven't learned the sections yet
      // (the Mac app reads this same payload); they are derived from the same groups, so
      // the three shapes cannot disagree.
      linkGroups,
      sectionOrder,
      links: linkGroups.flatMap(g => g.links),
      // Kept for pre-UNS-221 clients: flat main-link list (no per-section grouping).
      socialLinks: (linkGroups.find(g => g.section === 'social')?.links ?? []).map(l => ({
        platform: l.platform,
        url: l.url,
        displayName: l.displayName,
      })),
      // Kept for pre-UNS-221 clients: indexes into `links` above which a horizontal divider
      // is drawn (the old whole-list positions, social links included).
      linkDividers: legacyMainDividerIndexes(allLinks, profile?.link_dividers),
      releases: releasesWithSummary,
      releaseCount,
      bandcampFriday: bcFriday,
      // Tip links to /tip/{slug} when true. Goals only while taking tips.
      tips: { enabled: tipsEnabled, goals },
    };

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 's-maxage=300, stale-while-revalidate=86400',
        // The canonical slug, not the requested one, so an alias URL's cached copy is purged
        // by the same call as the artist's own.
        'Cache-Tag': `artist-page-${artistRow.slug}`,
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
/** Open goals for the page. Decoration: a failed read shows none rather than failing the page. */
async function readOpenGoals(artistId: string) {
  const client = getClient();
  if (!client) return [];
  try {
    return await getGoals(client, artistId, { openOnly: true });
  } catch (err) {
    Sentry.captureException(err, { extra: { context: 'artist-page.goals' } });
    return [];
  }
}

/**
 * The legacy `linkDividers` shape, for pre-UNS-221 clients: indexes into the flattened `links`
 * array (every link in stored order — patronage, marketplaces, official, social interleaved as
 * stored) which a divider is drawn above, so the legacy card keeps its grouping. The sectioned
 * payload is the forward shape; this keeps the old one consistent with the same stored values.
 */
function legacyMainDividerIndexes<T extends { platform: string }>(
  allLinks: T[],
  positions: number[] | null | undefined,
): number[] {
  if (!positions || positions.length === 0) return [];
  const isMainLink = (l: T) => PLATFORMS[l.platform]?.sectionCategory !== 'social';
  const mainIndexes = new Set(
    mainLinkDividerIndexes(allLinks, isMainLink, positions).map(n => n - 1),
  );
  const out: number[] = [];
  let mainCount = 0;
  allLinks.forEach((l, index) => {
    if (mainIndexes.has(mainCount)) out.push(index);
    if (isMainLink(l)) mainCount++;
  });
  return out;
}

export const handler = withSentry(handleRequest);
