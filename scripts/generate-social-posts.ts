/**
 * Generate and optionally schedule daily artist spotlight posts for social media.
 *
 * Alternates between:
 *   - Odd days: Independent artist with a verified Unstream page
 *   - Even days: Prominent artist with confirmed links from MusicBrainz data
 *
 * Output:
 *   data/social-posts/{week}/drafts.json   - All drafts for the week
 *   data/social-posts/{week}/day-{n}.md    - Human-readable draft per day
 *   data/social-posts/history.json         - Tracks which artists have been featured
 *
 * Usage:
 *   npx tsx scripts/generate-social-posts.ts                        # Current week
 *   npx tsx scripts/generate-social-posts.ts --week 2026-W13        # Specific week
 *   npx tsx scripts/generate-social-posts.ts --schedule              # Push to Buffer as DRAFTS (requires approval)
 *   npx tsx scripts/generate-social-posts.ts --schedule --publish    # Push to Buffer for auto-publication
 *   npx tsx scripts/generate-social-posts.ts --channels              # List Buffer channel IDs
 *
 * Environment:
 *   BUFFER_ACCESS_TOKEN   - Required for --schedule and --channels
 *   BUFFER_ORG_ID         - Required for --channels
 *   BUFFER_CHANNEL_IDS    - Required for --schedule (comma-separated: threads,bluesky,instagram)
 *   SUPABASE_URL          - Optional (falls back to production API)
 *   SUPABASE_SERVICE_KEY  - Optional (falls back to production API)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SOCIAL_DIR = join(DATA_DIR, 'social-posts');
const MANIFEST_PATH = join(DATA_DIR, 'artists-manifest.json');
const ARTIST_LIST_PATH = join(DATA_DIR, 'artist-list.json');
const HISTORY_PATH = join(SOCIAL_DIR, 'history.json');

const UNSTREAM_BASE = 'https://unstream.stream';

// Non-music Wikidata occupation QIDs — same list used in generate-artist-list.ts
const NON_MUSIC_OCCUPATIONS = [
  'Q245068',   // comedian
  'Q33999',    // actor
  'Q10800557', // film actor
  'Q10798782', // television actor
  'Q2405480',  // voice actor
  'Q947873',   // television presenter
  'Q82955',    // politician
  'Q2526255',  // film director
  'Q28389',    // screenwriter
  'Q36180',    // writer
  'Q49757',    // poet
  'Q15214752', // podcaster
  'Q170790',   // mathematician
  'Q901',      // scientist
  'Q2066131',  // athlete
  'Q937857',   // football player
];

// Hardcoded exclusions — safety net for when Wikidata queries fail (502s, timeouts).
// These are non-music artists who have Bandcamp pages for unrelated people with the same name.
const MANUAL_EXCLUDE_SLUGS = new Set([
  'lenny-bruce',       // deceased comedian, Bandcamp page is a different person
]);

// --- Types ---

interface ManifestArtist {
  name: string;
  slug: string;
  imageUrl: string;
  platformCount: number;
  lastUpdated: string;
}

interface ArtistPlatform {
  sourceId: string;
  url: string;
  latestRelease?: {
    title: string;
    type: string;
    url: string;
    imageUrl?: string;
    releaseDate?: string;
  };
}

interface ArtistData {
  id: string;
  name: string;
  type: string;
  imageUrl: string;
  platforms: ArtistPlatform[];
}

interface VerifiedArtist {
  slug: string;
  name: string;
  imageUrl: string | null;
}

interface SocialHandles {
  threads: string | null;   // e.g. "@tommorello"
  bluesky: string | null;   // e.g. "@tommorelloofficial.bsky.social"
  instagram: string | null;  // e.g. "@tommorello"
}

interface PostDraft {
  day: number; // 1-7 (Mon-Sun)
  date: string; // YYYY-MM-DD
  artistType: 'indie' | 'prominent' | 'promo';
  artistName: string;
  artistSlug: string;
  unstreamUrl: string;
  imageUrl: string | null;
  platforms: string[];
  latestRelease: string | null;
  socialHandles: SocialHandles;
  posts: {
    threads: string;
    bluesky: string;
    instagram: string;
  };
}

interface History {
  featured: string[]; // slugs
  lastUpdated: string;
}

// --- Platform display names ---

const PLATFORM_NAMES: Record<string, string> = {
  bandcamp: 'Bandcamp',
  faircamp: 'Faircamp',
  mirlo: 'Mirlo',
  qobuz: 'Qobuz',
  ampwall: 'Ampwall',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
  patreon: 'Patreon',
  kofi: 'Ko-fi',
  buymeacoffee: 'Buy Me a Coffee',
  bandwagon: 'Bandwagon',
  jamcoop: 'Jam.coop',
  funkwhale: 'Funkwhale',
  internetarchive: 'Internet Archive',
  hoopla: 'Hoopla',
  freegal: 'Freegal',
};

// Platforms worth highlighting in posts (direct-support platforms)
const HIGHLIGHT_PLATFORMS = new Set([
  'bandcamp', 'faircamp', 'mirlo', 'qobuz', 'ampwall',
  'bandwagon', 'jamcoop', 'patreon', 'kofi', 'buymeacoffee',
]);

// Payout percentages for context (human-readable for social posts)
const PAYOUT_PCT: Record<string, string> = {
  bandcamp: '82%',
  faircamp: '100%',
  mirlo: '93%',
  ampwall: '90%',
  bandwagon: '90%',
  jamcoop: '85%',
  // Qobuz intentionally excluded — it's per-stream, not per-sale, which muddies the "buy vs stream" framing
};

// --- Social handle extraction ---

/**
 * Extract social media handles from platform URLs.
 * Returns @handle strings for Threads, Bluesky, and Instagram.
 */
function extractSocialHandles(platforms: ArtistPlatform[]): SocialHandles {
  const findUrl = (sourceId: string) =>
    platforms.find(p => p.sourceId === sourceId)?.url || null;

  return {
    threads: parseThreadsHandle(findUrl('threads')),
    bluesky: parseBlueskyHandle(findUrl('bluesky')),
    instagram: parseInstagramHandle(findUrl('instagram')),
  };
}

function parseInstagramHandle(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('instagram.com')) return null;
    // Path: /username/ or /username
    const segment = parsed.pathname.replace(/^\/|\/$/g, '').split('/')[0];
    // Reject non-profile paths
    if (!segment || ['p', 'reel', 'explore', 'stories', 'tv'].includes(segment)) return null;
    return `@${segment}`;
  } catch { return null; }
}

function parseThreadsHandle(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('threads.net') && !parsed.hostname.includes('threads.com')) return null;
    // Path: /@username or /username
    const segment = parsed.pathname.replace(/^\/|\/$/g, '').split('/')[0];
    if (!segment) return null;
    const handle = segment.startsWith('@') ? segment.slice(1) : segment;
    if (!handle) return null;
    return `@${handle}`;
  } catch { return null; }
}

function parseBlueskyHandle(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // Only accept bsky.app/profile/... URLs (rejects garbage like share links)
    if (parsed.hostname !== 'bsky.app') return null;
    const match = parsed.pathname.match(/^\/profile\/([^/]+)/);
    if (!match) return null;
    const handle = match[1];
    // Basic sanity: handle should contain a dot (e.g. user.bsky.social or custom.domain)
    if (!handle.includes('.')) return null;
    return `@${handle}`;
  } catch { return null; }
}

// --- Content generation ---

/**
 * Clean up release titles — source data (especially Qobuz) often appends artist
 * names, has excess whitespace, or includes other artifacts.
 * Returns null if the title is too garbled to use.
 */
function cleanReleaseTitle(title: string, artistName: string): string | null {
  // Collapse all whitespace (newlines, tabs, multiple spaces) into single spaces
  let cleaned = title.replace(/\s+/g, ' ').trim();

  // Remove all occurrences of the artist name (case-insensitive)
  // Qobuz data often embeds artist names: "To All My Friends Xavier Cugat Xavier Cugat Orchestra"
  const artistPattern = new RegExp(`\\b${artistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  cleaned = cleaned.replace(artistPattern, '').replace(/\s+/g, ' ').trim();

  // If title is still very long (>60 chars), it's probably garbled data — skip it
  if (cleaned.length > 60) return null;

  // If nothing meaningful left after cleanup, skip
  if (cleaned.length < 2) return null;

  return cleaned;
}

/**
 * Extract the useful bits from platform data for content generation.
 */
function getContentContext(platforms: ArtistPlatform[], artistName: string) {
  const directPlatforms = platforms
    .filter(p => HIGHLIGHT_PLATFORMS.has(p.sourceId) && !p.url.includes('duckduckgo'))
    .map(p => p.sourceId);

  const topPlatform = directPlatforms[0];
  const topPlatformName = topPlatform ? (PLATFORM_NAMES[topPlatform] || topPlatform) : null;
  const payout = topPlatform ? PAYOUT_PCT[topPlatform] : null;

  const rawRelease = platforms
    .map(p => p.latestRelease)
    .filter(Boolean)
    .sort((a, b) => {
      const dateA = a?.releaseDate ? new Date(a.releaseDate).getTime() : 0;
      const dateB = b?.releaseDate ? new Date(b.releaseDate).getTime() : 0;
      return dateB - dateA;
    })[0];

  // Clean the release title (Qobuz often appends artist name).
  // If the title is too garbled, drop the release entirely.
  const cleanedTitle = rawRelease ? cleanReleaseTitle(rawRelease.title, artistName) : null;
  const latestRelease = rawRelease && cleanedTitle
    ? { ...rawRelease, title: cleanedTitle }
    : undefined;

  return { directPlatforms, topPlatform, topPlatformName, payout, latestRelease };
}

/**
 * Build platform-specific post drafts for an artist.
 *
 * Voice notes (from voice-and-positioning.md):
 *   Threads: Most personal. Off-the-cuff, lowercase OK. Thoughts shared with
 *            people you're already in conversation with. No hashtags (use Tags).
 *   Bluesky: Casual, direct, tight (300 chars). Lead with hook.
 *            Community hashtags at end.
 *   Instagram: Caption under the artist image. Can breathe a bit more.
 *              Personal but slightly more structured.
 */
function generateDrafts(
  artist: { name: string; slug: string; imageUrl: string | null },
  artistType: 'indie' | 'prominent',
  platforms: ArtistPlatform[],
  dayOfWeek: number,
  handles: SocialHandles
): PostDraft['posts'] {
  const unstreamUrl = artistType === 'indie'
    ? `${UNSTREAM_BASE}/a/${artist.slug}`
    : `${UNSTREAM_BASE}/artist/${artist.slug}`;

  const ctx = getContentContext(platforms, artist.name);
  const angle = dayOfWeek % 4;

  // Use handles in place of artist name on matching platforms.
  // Threads can tag Instagram handles too (same Meta namespace).
  const tTag = handles.threads || handles.instagram;
  const bTag = handles.bluesky;
  const iTag = handles.instagram;

  // Tagged name for first mention on each platform; falls back to plain name.
  const tName = tTag || artist.name;
  const bName = bTag || artist.name;
  const iName = iTag || artist.name;

  let threads: string;
  let bluesky: string;
  let instagram: string;

  if (artistType === 'indie') {
    // --- INDIE / VERIFIED ---
    // These are smaller artists who claimed their Unstream page.
    // Voice: genuine discovery, like recommending a band to a friend.
    switch (angle) {
      case 0: // thinking-out-loud discovery
        if (ctx.topPlatformName && ctx.payout) {
          threads = `${tName} claimed their page on Unstream and i've been poking around their ${ctx.topPlatformName} — ${ctx.payout} of every sale goes straight to them. that's the whole idea.\n\n${unstreamUrl}`;
        } else {
          threads = `${tName} claimed their page on Unstream. all their direct-support links in one spot, no streaming middlemen.\n\n${unstreamUrl}`;
        }
        bluesky = ctx.topPlatformName
          ? `${bName} is on ${ctx.topPlatformName} and has a page on Unstream with all their direct links.\n\n${unstreamUrl}`
          : `${bName} has a page on Unstream — all their direct-support links in one spot.\n\n${unstreamUrl}`;
        instagram = ctx.topPlatformName
          ? `${iName} has a verified page on Unstream.\n\nYou can buy their music directly on ${ctx.topPlatformName}${ctx.payout ? ` where they keep ${ctx.payout}` : ''} — or check all their links in one place.\n\n${unstreamUrl}`
          : `${iName} has a verified page on Unstream — every link you need to support them directly, no streaming required.\n\n${unstreamUrl}`;
        break;

      case 1: // payout angle, conversational
        if (ctx.topPlatformName && ctx.payout) {
          threads = `${tName} keeps ${ctx.payout} of every sale on ${ctx.topPlatformName}. on Spotify they'd get about $0.003 per stream. pretty big difference.\n\n${unstreamUrl}`;
          bluesky = `${bName} on ${ctx.topPlatformName}: ${ctx.payout} per sale. On Spotify: ~$0.003 per stream. That adds up.\n\n${unstreamUrl}`;
          instagram = `${iName} keeps ${ctx.payout} of every sale on ${ctx.topPlatformName}.\n\nOn Spotify they'd get about $0.003 per stream.\n\nOne album purchase does more than thousands of streams.\n\n${unstreamUrl}`;
        } else {
          threads = `you can buy ${tName}'s music directly and they get most of the money. or you can stream it and they get fractions of a penny. worth thinking about.\n\n${unstreamUrl}`;
          bluesky = `You can buy ${bName}'s music directly — they get way more than streaming would ever pay them.\n\n${unstreamUrl}`;
          instagram = `You can buy ${iName}'s music directly and they get most of the money.\n\nOr you can stream it and they get fractions of a penny.\n\nAll their links: ${unstreamUrl}`;
        }
        break;

      case 2: // has music on platform
        if (ctx.topPlatformName) {
          threads = `${tName} has music on ${ctx.topPlatformName} you can buy directly${ctx.payout ? ` — they keep ${ctx.payout}` : ''}. that's what direct support looks like.\n\n${unstreamUrl}`;
          bluesky = `${bName} has music on ${ctx.topPlatformName} — buy it where the money goes to the artist.\n\n${unstreamUrl}`;
          instagram = `${iName} has music on ${ctx.topPlatformName} you can buy directly${ctx.payout ? ` — they keep ${ctx.payout} of every sale` : ''} instead of adding another fraction-of-a-penny stream.\n\n${unstreamUrl}`;
        } else {
          // fallback: warm recommendation
          threads = `been looking at ${tName}'s page on Unstream — they've got ${ctx.directPlatforms.length || 'a few'} places where you can buy their stuff directly. worth a look 👀\n\n${unstreamUrl}`;
          bluesky = `${bName} on Unstream — all their direct-support links in one spot.\n\n${unstreamUrl}`;
          instagram = `${iName} has a verified page on Unstream with all their direct-support links.\n\nSkip the stream, support them for real.\n\n${unstreamUrl}`;
        }
        break;

      default: // casual nudge
        threads = `if you like ${tName}, go buy their music instead of streaming it. they have a page on Unstream with all their direct links.\n\n${unstreamUrl}`;
        bluesky = `If you like ${bName}, buy their music instead of streaming it.\n\n${unstreamUrl}`;
        instagram = `If you like ${iName}, you can support them directly instead of streaming.\n\nAll their links in one place:\n${unstreamUrl}`;
    }
  } else {
    // --- PROMINENT / MUSICBRAINZ ---
    // These are bigger names people already know. The angle: "did you know
    // you can just... buy their music? and they get way more of your money?"
    switch (angle) {
      case 0: // genuine surprise — did you know?
        if (ctx.topPlatformName) {
          threads = `did you know you can just... buy ${tName}'s music? like, on ${ctx.topPlatformName}? ${ctx.payout ? `they get ${ctx.payout} of it` : 'and they get way more of your money'} compared to the fraction of a penny per stream.\n\n${unstreamUrl}`;
          bluesky = `Did you know you can buy ${bName}'s music on ${ctx.topPlatformName}? ${ctx.payout ? `${ctx.payout} to the artist` : 'Way more than streaming pays'}.\n\n${unstreamUrl}`;
        } else {
          threads = `did you know you can just... buy ${tName}'s music online? and they get way more of your money than from streaming?\n\n${unstreamUrl}`;
          bluesky = `Did you know you can buy ${bName}'s music directly? Way more goes to them than streaming.\n\n${unstreamUrl}`;
        }
        instagram = `You probably already listen to ${iName}.\n\nBut did you know you can buy their music directly${ctx.topPlatformName ? ` on ${ctx.topPlatformName}` : ''}? ${ctx.payout ? `They get ${ctx.payout} of every sale` : 'They get way more of your money'} compared to what streaming pays.\n\n${unstreamUrl}`;
        break;

      case 1: // the math
        if (ctx.topPlatformName && ctx.payout) {
          threads = `one ${ctx.topPlatformName} purchase of a ${artist.name} album does more for them than mass streaming it for years. they keep ${ctx.payout}. on streaming apps, they get about $0.003 every time you press play.\n\n${unstreamUrl}`;
          bluesky = `One ${ctx.topPlatformName} purchase of ${bName} > years of streaming. ${ctx.payout} vs ~$0.003/play.\n\n${unstreamUrl}`;
        } else {
          threads = `one album purchase does more for ${tName} than streaming them for years. on streaming apps they get about $0.003 every time you press play. buying it? they keep most of it.\n\n${unstreamUrl}`;
          bluesky = `One album purchase does more for ${bName} than years of streaming. ~$0.003 per play vs keeping most of the sale.\n\n${unstreamUrl}`;
        }
        instagram = `One album purchase does more for ${iName} than streaming them for years.\n\nStreaming: ~$0.003 per play\nBuying${ctx.topPlatformName ? ` on ${ctx.topPlatformName}` : ''}: ${ctx.payout ? `${ctx.payout} goes to them` : 'they keep most of it'}\n\n${unstreamUrl}`;
        break;

      case 2: // has music on platform
        if (ctx.topPlatformName) {
          threads = `${tName} has music on ${ctx.topPlatformName} that you can buy directly${ctx.payout ? ` — they keep ${ctx.payout} of every sale` : ''}. way better than what streaming pays them.\n\n${unstreamUrl}`;
          bluesky = `${bName} has music on ${ctx.topPlatformName} you can buy directly. ${ctx.payout ? `${ctx.payout} to the artist.` : 'Way more than streaming pays.'}\n\n${unstreamUrl}`;
          instagram = `${iName} has music on ${ctx.topPlatformName} that you can buy directly${ctx.payout ? ` — they keep ${ctx.payout} of every sale` : ''}.\n\nWay better than what streaming pays them.\n\n${unstreamUrl}`;
        } else {
          threads = `you can buy ${tName}'s music directly online and they get way more out of it than streaming would ever pay them. worth knowing about.\n\n${unstreamUrl}`;
          bluesky = `You can buy ${bName}'s music directly. They get way more than streaming pays.\n\n${unstreamUrl}`;
          instagram = `You can buy ${iName}'s music directly online and they get way more than the fractions of a penny streaming pays.\n\nAll their links: ${unstreamUrl}`;
        }
        break;

      default: // earnest nudge
        if (ctx.topPlatformName) {
          threads = `${tName} is on ${ctx.topPlatformName}. you can buy their music there and they get ${ctx.payout || 'most of it'}. if you're a fan, that's a pretty good way to show it.\n\n${unstreamUrl}`;
          bluesky = `${bName} is on ${ctx.topPlatformName}. Buy their music there. Or stream it for ~$0.003. Your call.\n\n${unstreamUrl}`;
        } else {
          threads = `you can buy ${tName}'s music directly online — they get way more out of it than streaming. if you're a fan, it's worth looking into.\n\n${unstreamUrl}`;
          bluesky = `You can buy ${bName}'s music directly — they get way more than streaming pays.\n\n${unstreamUrl}`;
        }
        instagram = `${iName} is on ${ctx.topPlatformName || 'platforms where artists keep most of the money'}.\n\nYou can buy their music directly${ctx.payout ? ` and they get ${ctx.payout}` : ''}. Or you can stream it for fractions of a penny. Your call.\n\n${unstreamUrl}`;
    }
  }

  // --- Hashtags & tags ---

  // Bluesky: community hashtags for discoverability
  const bskyTags = ['#musicsky', '#fairtrademusic'];
  if (artistType === 'indie') bskyTags.push('#indiemusic');
  if (ctx.latestRelease) bskyTags.push('#newmusic');
  bskyTags.push('#supportartists');
  bluesky += `\n\n${bskyTags.join(' ')}`;

  // Instagram: hashtags appended to caption
  const igTags = ['#music', '#fairtrademusic', '#supportartists'];
  if (artistType === 'indie') igTags.push('#indiemusic', '#independentmusic');
  if (ctx.latestRelease) igTags.push('#newmusic', '#newrelease');
  if (ctx.topPlatform === 'bandcamp') igTags.push('#bandcamp');
  igTags.push('#buymusic');
  instagram += `\n\n${igTags.join(' ')}`;

  // Threads: no hashtags in post body (use Tags feature via Buffer metadata).
  // The Threads topic "Music Threads" is applied at schedule time, not in text.

  // Enforce character limits with warnings (don't auto-truncate — human should trim)
  if (bluesky.length > 300) {
    console.warn(`  ⚠ Bluesky draft for ${artist.name} over limit (${bluesky.length}/300) — needs manual trim`);
  }
  if (threads.length > 500) {
    console.warn(`  ⚠ Threads draft for ${artist.name} over limit (${threads.length}/500) — needs manual trim`);
  }

  return { threads, bluesky, instagram };
}

// --- Promo post generation ---

interface ShippedFeature {
  id: string;
  title: string;
  description: string;
  date: string;
  announced: boolean;
}

const SHIPPED_FEATURES_PATH = join(DATA_DIR, 'shipped-features.json');

function loadShippedFeatures(): ShippedFeature[] {
  if (!existsSync(SHIPPED_FEATURES_PATH)) return [];
  return JSON.parse(readFileSync(SHIPPED_FEATURES_PATH, 'utf-8'));
}

function markFeatureAnnounced(featureId: string) {
  const features = loadShippedFeatures();
  const feature = features.find(f => f.id === featureId);
  if (feature) {
    feature.announced = true;
    writeFileSync(SHIPPED_FEATURES_PATH, JSON.stringify(features, null, 2));
  }
}

/**
 * Generate a feature announcement post for a recently shipped feature.
 * Voice: sideways/personal announcement, not "we're excited to announce."
 */
function generateFeaturePost(feature: ShippedFeature): PostDraft['posts'] {
  const url = UNSTREAM_BASE;

  // These are starting-point drafts — the voice here is intentionally
  // understated. You'll want to edit these to feel more natural for
  // whatever the feature actually is.
  // feature.description should read well after "new on Unstream:" — write it
  // as a standalone blurb, not a sentence that starts with "Unstream".
  const threads = `new on Unstream: ${feature.description}\n\n${url}`;
  const bluesky = `New on Unstream: ${feature.description}\n\n${url}\n\n#musicsky #fairtrademusic #supportartists`;
  const instagram = `New on Unstream:\n\n${feature.description}\n\n${url}\n\n#music #fairtrademusic #supportartists #indiemusic #buymusic`;

  return { threads, bluesky, instagram };
}

/**
 * Generate a weekly promotional post about Unstream itself.
 * If there's an unannounced shipped feature, promotes that instead.
 * Otherwise rotates through general promo angles.
 *
 * Voice: sideways/personal, never "check out our product" —
 * more like thinking out loud about why it exists.
 */
function generatePromoPost(weekNumber: number): { posts: PostDraft['posts']; featureId?: string } {
  // Check for unannounced features first
  const features = loadShippedFeatures();
  const unannounced = features.find(f => !f.announced);

  if (unannounced) {
    return { posts: generateFeaturePost(unannounced), featureId: unannounced.id };
  }

  // General promo rotation
  const angle = weekNumber % 6;
  const url = UNSTREAM_BASE;

  let threads: string;
  let bluesky: string;
  let instagram: string;

  switch (angle) {
    case 0: // what it does
      threads = `i built a free tool that searches 17+ platforms to help you find where to buy music directly from artists. no account, no tracking, no paywall.\n\n${url}`;
      bluesky = `Free tool that searches 17+ platforms to find where to buy music directly from artists. No account needed.\n\n${url}`;
      instagram = `Unstream searches 17+ alternative music platforms to help you find where to buy music directly from artists.\n\nNo account. No tracking. No paywall. Just a way to get more money to the people who make the music.\n\n${url}`;
      break;

    case 1: // the why
      threads = `the average Spotify stream pays an artist about $0.003. one Bandcamp purchase can equal thousands of streams. that's why i made Unstream — it finds where you can buy an artist's music directly.\n\n${url}`;
      bluesky = `$0.003 per Spotify stream. One Bandcamp purchase = thousands of streams. That's why Unstream exists.\n\n${url}`;
      instagram = `The average Spotify stream pays an artist about $0.003.\n\nOne album purchase on Bandcamp is worth thousands of streams.\n\nUnstream helps you find where to buy music directly from the artists you love.\n\n${url}`;
      break;

    case 2: // artist pages
      threads = `artists can claim their page on Unstream for free — it puts all your direct-support links in one place. Bandcamp, Faircamp, Mirlo, Patreon, whatever you've got.\n\n${url}/artists`;
      bluesky = `Artists: claim your free page on Unstream. All your direct-support links in one place.\n\n${url}/artists`;
      instagram = `If you're an artist, you can claim your page on Unstream for free.\n\nIt puts all your direct-support links in one place — Bandcamp, Faircamp, Mirlo, Patreon, whatever you've got.\n\n${url}/artists`;
      break;

    case 3: // open source / indie
      threads = `Unstream is free, open source, and built by one person. no VC funding, no data harvesting, no premium tier. the whole point is getting more money to artists, not less.\n\n${url}`;
      bluesky = `Unstream is free, open source, and built by one person. The whole point is getting more money to artists.\n\n${url}`;
      instagram = `Unstream is free, open source, and built by one person.\n\nNo VC funding. No data harvesting. No premium tier.\n\nThe whole point is getting more money to artists, not less.\n\n${url}`;
      break;

    case 4: // how it works
      threads = `search for any artist on Unstream and it checks 17+ platforms — Bandcamp, Faircamp, Mirlo, Qobuz, and more — in a few seconds. shows you where to buy their music directly — with payout percentages so you know where your money goes.\n\n${url}`;
      bluesky = `Search any artist on Unstream → it checks 17+ platforms and shows where to buy their music directly, with payout percentages.\n\n${url}`;
      instagram = `Search for any artist on Unstream.\n\nIt checks 17+ platforms — Bandcamp, Faircamp, Mirlo, Qobuz, and more — in seconds — and shows you where to buy their music directly, with transparent payout percentages.\n\n${url}`;
      break;

    default: // the pitch, earnest
      threads = `if you listen to music and care about the people who make it, this might be useful to you. Unstream finds where you can support any artist directly instead of streaming.\n\n${url}`;
      bluesky = `If you care about the people who make the music you listen to — Unstream finds where to support them directly.\n\n${url}`;
      instagram = `If you listen to music and care about the people who make it, this might be useful.\n\nUnstream finds where you can support any artist directly instead of streaming.\n\nFree. No account needed.\n\n${url}`;
  }

  // Hashtags
  bluesky += '\n\n#musicsky #fairtrademusic #supportartists #indiemusic';
  instagram += '\n\n#music #fairtrademusic #supportartists #indiemusic #buymusic #bandcamp';

  return { posts: { threads, bluesky, instagram } };
}

// --- Data loading ---

function loadHistory(): History {
  if (existsSync(HISTORY_PATH)) {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'));
  }
  return { featured: [], lastUpdated: new Date().toISOString() };
}

function saveHistory(history: History) {
  history.lastUpdated = new Date().toISOString();
  if (!existsSync(SOCIAL_DIR)) mkdirSync(SOCIAL_DIR, { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function loadManifest(): ManifestArtist[] {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

interface ArtistListEntry {
  name: string;
  slug: string;
  musicbrainzId: string;
}

function loadArtistList(): ArtistListEntry[] {
  if (!existsSync(ARTIST_LIST_PATH)) return [];
  return JSON.parse(readFileSync(ARTIST_LIST_PATH, 'utf-8'));
}

/**
 * Query Wikidata for the artists these posts must not feature, by MusicBrainz ID:
 *
 *   * non-music artists — comedians, actors, athletes, whose Bandcamp page is usually a different
 *     person with the same name;
 *   * artists who have died. Every post says some variant of "support them directly", and 107 of
 *     the artists in this pool are dead. Five had already gone out — Sara Tavares, Dusty Hill,
 *     Brook Benton, Lhasa de Sela and Lex Barker — before anything checked.
 *
 * Returns the slugs to exclude plus whether the lookup was **complete**. That flag is the point:
 * every batch here is wrapped in a try/catch that warns and moves on, so a Wikidata outage used
 * to produce an empty exclusion set, which reads identically to "nobody needs excluding" and
 * would let exactly the posts this guards against go out. A failed lookup is not a negative
 * result; the caller drops the pool rather than trusting a partial answer.
 *
 * Runs a single SPARQL query in batches to stay within Wikidata limits.
 */
async function findExcludedArtists(
  artistList: ArtistListEntry[]
): Promise<{ slugs: Set<string>; complete: boolean }> {
  const excludeSlugs = new Set<string>();
  let complete = true;
  const mbidToSlug = new Map(artistList.map(a => [a.musicbrainzId, a.slug]));

  // Process in batches of 200 (Wikidata VALUES clause limit)
  const BATCH_SIZE = 150;
  const mbids = artistList.map(a => a.musicbrainzId);
  const totalBatches = Math.ceil(mbids.length / BATCH_SIZE);

  for (let i = 0; i < mbids.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = mbids.slice(i, i + BATCH_SIZE);
    const valuesClause = batch.map(id => `"${id}"`).join(' ');

    const occupationValues = NON_MUSIC_OCCUPATIONS.map(q => `wd:${q}`).join(' ');
    // One query, two reasons to exclude: a non-music occupation (P106) or a date of death (P570).
    // Matched through the artist's own MusicBrainz ID (P434), never by name — a name match pairs
    // "Sebastian Bach" with Johann Sebastian Bach and "Jack White" with a footballer.
    const sparql = `
SELECT DISTINCT ?mbid WHERE {
  VALUES ?mbid { ${valuesClause} }
  ?artist wdt:P434 ?mbid .
  {
    VALUES ?nonMusicOccupation { ${occupationValues} }
    ?artist wdt:P106 ?nonMusicOccupation .
  } UNION {
    ?artist wdt:P570 ?dateOfDeath .
  }
}`;

    try {
      const url = 'https://query.wikidata.org/sparql';
      // Use POST to avoid URL length limits with large VALUES clauses
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'Unstream/1.0 (https://unstream.stream; support@unstream.stream)',
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/sparql-results+json',
        },
        body: new URLSearchParams({ query: sparql }),
        signal: AbortSignal.timeout(60000),
      });

      if (res.ok) {
        const data = await res.json();
        const found = data.results.bindings.length;
        if (found > 0) {
          for (const binding of data.results.bindings) {
            const mbid = binding.mbid?.value;
            if (mbid) {
              const slug = mbidToSlug.get(mbid);
              if (slug) excludeSlugs.add(slug);
            }
          }
        }
      } else {
        console.warn(`  ⚠ Wikidata batch ${batchNum}/${totalBatches} returned ${res.status}`);
        complete = false;
      }
    } catch (err) {
      console.warn(`  ⚠ Wikidata batch ${batchNum}/${totalBatches} failed: ${err instanceof Error ? err.message : err}`);
      complete = false;
    }

    // Be nice to Wikidata
    if (i + BATCH_SIZE < mbids.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return { slugs: excludeSlugs, complete };
}

function loadArtistData(slug: string): ArtistData | null {
  const path = join(DATA_DIR, 'artists', `${slug}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return Array.isArray(data) ? data[0] : data;
}

async function fetchVerifiedArtists(): Promise<VerifiedArtist[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('⚠ SUPABASE_URL/SUPABASE_SERVICE_KEY not set — fetching from production API');
    const res = await fetch(`${UNSTREAM_BASE}/api/artist-directory`);
    const data = await res.json();
    return data.artists || [];
  }

  // Use Supabase REST API directly to avoid importing the client
  const profilesRes = await fetch(
    `${supabaseUrl}/rest/v1/artist_profiles?verified_at=not.is.null&select=artist_id,custom_image_url`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
  );
  const profiles = await profilesRes.json();
  if (!profiles?.length) return [];

  const artistIds = profiles.map((p: { artist_id: string }) => p.artist_id);
  const artistsRes = await fetch(
    `${supabaseUrl}/rest/v1/artists?id=in.(${artistIds.join(',')})&select=id,name,slug,image_url`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
  );
  const artists = await artistsRes.json();

  const customImages = new Map(
    profiles.filter((p: { custom_image_url: string }) => p.custom_image_url)
      .map((p: { artist_id: string; custom_image_url: string }) => [p.artist_id, p.custom_image_url])
  );

  return (artists || []).map((a: { id: string; slug: string; name: string; image_url: string }) => ({
    slug: a.slug,
    name: a.name,
    imageUrl: customImages.get(a.id) || a.image_url || null,
  }));
}

// --- Week calculation ---

function getWeekDates(weekStr?: string): { week: string; dates: string[] } {
  let startDate: Date;

  if (weekStr) {
    // Parse ISO week: 2026-W13
    const [yearStr, weekNumStr] = weekStr.split('-W');
    const year = parseInt(yearStr);
    const weekNum = parseInt(weekNumStr);
    // Find Jan 4 (always in week 1), then offset
    const jan4 = new Date(year, 0, 4);
    const dayOfWeek = jan4.getDay() || 7; // Mon=1..Sun=7
    startDate = new Date(jan4);
    startDate.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
  } else {
    // Current week (start on Monday)
    const now = new Date();
    const day = now.getDay() || 7;
    startDate = new Date(now);
    startDate.setDate(now.getDate() - day + 1);
  }

  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  // Compute ISO week string
  const thu = new Date(startDate);
  thu.setDate(startDate.getDate() + 3);
  const yearStart = new Date(thu.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((thu.getTime() - yearStart.getTime()) / 86400000 + yearStart.getDay() + 1) / 7);
  const week = `${thu.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

  return { week, dates };
}

// --- Artist selection ---

// Slugs to deprioritize — these are "us" and shouldn't appear in the first cycle.
// They'll still be featured eventually once the pool cycles.
const DEPRIORITIZE_SLUGS = new Set(['kid-lightbulbs']);

function pickArtist(
  pool: { slug: string; name: string; imageUrl: string | null }[],
  history: History
): { slug: string; name: string; imageUrl: string | null } | null {
  // Prefer artists not yet featured
  let unfeatured = pool.filter(a => !history.featured.includes(a.slug));

  // On the first pass through the pool, deprioritize our own project(s)
  if (unfeatured.length > 1) {
    const withoutSelf = unfeatured.filter(a => !DEPRIORITIZE_SLUGS.has(a.slug));
    if (withoutSelf.length > 0) unfeatured = withoutSelf;
  }

  if (unfeatured.length > 0) {
    const idx = Math.floor(Math.random() * unfeatured.length);
    return unfeatured[idx];
  }

  // Everyone's been featured — reset history and start a new cycle
  if (pool.length > 0) {
    history.featured = [];
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx];
  }

  return null;
}

// --- Buffer GraphQL integration ---
// Uses Buffer's GraphQL API at https://api.buffer.com
// Docs: https://developers.buffer.com

const BUFFER_GRAPHQL = 'https://api.buffer.com';

async function bufferGraphQL(query: string, variables?: Record<string, unknown>) {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) throw new Error('BUFFER_ACCESS_TOKEN not set');

  const res = await fetch(BUFFER_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();

  if (!res.ok || data.errors) {
    const errMsg = data.errors?.map((e: { message: string }) => e.message).join('; ') || JSON.stringify(data);
    throw new Error(`Buffer API error (${res.status}): ${errMsg}`);
  }

  return data;
}

async function listChannels() {
  const orgId = process.env.BUFFER_ORG_ID;
  if (!orgId) {
    console.error('\n✗ BUFFER_ORG_ID not set. Find it in your Buffer settings URL.');
    process.exit(1);
  }

  const result = await bufferGraphQL(`
    query GetChannels($orgId: ID!) {
      channels(input: { organizationId: $orgId }) {
        id
        name
        service
      }
    }
  `, { orgId });

  const channels = result.data?.channels || [];
  console.log('\nBuffer channels:\n');
  for (const c of channels) {
    console.log(`  ${c.service} — ${c.name} (ID: ${c.id})`);
  }
  console.log('\nSet these IDs in the BUFFER_CHANNEL_IDS env var (comma-separated).');
  console.log('Order: threads,bluesky,instagram\n');
}

interface CreatePostOpts {
  channelId: string;
  text: string;
  dueAt: string;
  imageUrl?: string | null;
  saveToDraft: boolean;
  metadata?: Record<string, unknown>;
}

async function createBufferPost(opts: CreatePostOpts) {
  const input: Record<string, unknown> = {
    channelId: opts.channelId,
    text: opts.text,
    dueAt: opts.dueAt,
    schedulingType: 'automatic',
    mode: 'customScheduled',
    saveToDraft: opts.saveToDraft,
  };

  if (opts.imageUrl) {
    input.assets = [{ image: { url: opts.imageUrl } }];
  }

  if (opts.metadata) {
    input.metadata = opts.metadata;
  }

  const result = await bufferGraphQL(`
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            status
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `, { input });

  const data = result.data?.createPost;
  if (data?.post) {
    return { success: true, id: data.post.id, status: data.post.status };
  }
  return { success: false, error: data?.message || 'Unknown error' };
}

// --- Markdown output ---

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function draftToMarkdown(draft: PostDraft): string {
  const dayName = DAY_NAMES[draft.day - 1];
  const typeLabels = { indie: 'Indie (Verified Unstream)', prominent: 'Prominent (MusicBrainz)', promo: 'Unstream Promo' };
  const typeLabel = typeLabels[draft.artistType];

  return `# ${dayName}, ${draft.date}

**Artist:** ${draft.artistName}
**Type:** ${typeLabel}
**Unstream:** ${draft.unstreamUrl}
**Platforms:** ${draft.platforms.join(', ')}
${draft.latestRelease ? `**Latest release:** ${draft.latestRelease}\n` : ''}${draft.imageUrl ? `**Image:** ${draft.imageUrl}\n` : ''}**Handles:** ${[
    draft.socialHandles.threads ? `Threads: ${draft.socialHandles.threads}` : null,
    draft.socialHandles.bluesky ? `Bluesky: ${draft.socialHandles.bluesky}` : null,
    draft.socialHandles.instagram ? `IG: ${draft.socialHandles.instagram}` : null,
  ].filter(Boolean).join(' | ') || '(none found)'}

---

## Threads (${draft.posts.threads.length}/500 chars)

${draft.posts.threads}

---

## Bluesky (${draft.posts.bluesky.length}/300 chars)

${draft.posts.bluesky}

---

## Instagram

${draft.posts.instagram}

---

*Edit these drafts, then run with --schedule to push to Buffer.*
`;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const weekArg = args.includes('--week') ? args[args.indexOf('--week') + 1] : undefined;
  const doSchedule = args.includes('--schedule');
  const doPublish = args.includes('--publish');
  const doChannels = args.includes('--channels');

  if (doChannels) {
    await listChannels();
    return;
  }

  const { week, dates } = getWeekDates(weekArg);
  console.log(`\nGenerating posts for week ${week} (${dates[0]} → ${dates[6]})\n`);

  // Load data
  const history = loadHistory();
  const manifest = loadManifest();
  const artistList = loadArtistList();
  const verifiedArtists = await fetchVerifiedArtists();

  console.log(`  ${verifiedArtists.length} verified indie artists`);
  console.log(`  ${manifest.length} prominent artists in manifest`);

  if (verifiedArtists.length === 0) {
    console.warn('⚠ No verified artists found. Indie days will be skipped.');
  }

  // Filter out non-music artists (comedians, actors, etc.) and artists who have died, via Wikidata
  console.log('  Checking Wikidata for non-music and deceased artists...');
  const excluded = await findExcludedArtists(artistList);
  if (excluded.slugs.size > 0) {
    console.log(`  Excluding ${excluded.slugs.size} non-music or deceased artists`);
  }

  // Merge Wikidata exclusions with hardcoded safety net
  for (const slug of MANUAL_EXCLUDE_SLUGS) excluded.slugs.add(slug);

  // Filter manifest to only music artists with good data.
  //
  // An incomplete Wikidata lookup empties the exclusion set, which is indistinguishable from
  // "nothing to exclude" — and the thing being excluded is posts telling people to go support a
  // dead artist. So an incomplete lookup drops this pool entirely for the run: the verified indie
  // artists below need no Wikidata check and can carry the week on their own.
  const prominentPool = !excluded.complete
    ? []
    : manifest.filter(a => {
        if (excluded.slugs.has(a.slug)) return false;
        const data = loadArtistData(a.slug);
        if (!data) return false;
        return data.platforms.some(p => HIGHLIGHT_PLATFORMS.has(p.sourceId) && !p.url.includes('duckduckgo'));
      });

  if (!excluded.complete) {
    console.warn(
      '  ⚠ Wikidata lookup was incomplete — skipping the prominent-artist pool for this run ' +
        'rather than risk featuring a deceased or non-music artist.'
    );
  }
  console.log(`  ${prominentPool.length} prominent artists with direct-support platforms\n`);

  const weekDir = join(SOCIAL_DIR, week);
  if (!existsSync(weekDir)) mkdirSync(weekDir, { recursive: true });

  const drafts: PostDraft[] = [];

  // Parse week number for promo post rotation
  const weekNum = parseInt(week.split('-W')[1], 10);

  for (let day = 1; day <= 7; day++) {
    const date = dates[day - 1];

    // Day 7 (Sunday): promotional post about Unstream itself
    // If there's an unannounced shipped feature, promote that; otherwise general promo.
    if (day === 7) {
      const promo = generatePromoPost(weekNum);
      const isFeature = !!promo.featureId;
      const draft: PostDraft = {
        day,
        date,
        artistType: 'promo',
        artistName: 'Unstream',
        artistSlug: 'unstream',
        unstreamUrl: UNSTREAM_BASE,
        imageUrl: null,
        platforms: [],
        latestRelease: null,
        socialHandles: { threads: null, bluesky: null, instagram: null },
        posts: promo.posts,
      };
      drafts.push(draft);

      if (isFeature) {
        markFeatureAnnounced(promo.featureId!);
        console.log(`  📢 ${DAY_NAMES[day - 1]} ${date}: Feature announcement — "${promo.featureId}"`);
      } else {
        console.log(`  📢 ${DAY_NAMES[day - 1]} ${date}: Unstream promo (angle ${weekNum % 6})`);
      }

      writeFileSync(join(weekDir, `day-${day}.md`), draftToMarkdown(draft));
      continue;
    }

    // Days 1-6: alternate indie (odd) / prominent (even)
    const isIndie = day % 2 === 1; // Mon=indie, Tue=prominent, Wed=indie...

    let artist: { slug: string; name: string; imageUrl: string | null } | null = null;
    let artistType: 'indie' | 'prominent';
    let platforms: ArtistPlatform[] = [];

    if (isIndie && verifiedArtists.length > 0) {
      artistType = 'indie';
      artist = pickArtist(verifiedArtists, history);
      if (artist) {
        // Fetch platform data from production API
        try {
          const res = await fetch(`${UNSTREAM_BASE}/api/artist?slug=${artist.slug}`);
          if (res.ok) {
            const data = await res.json();
            platforms = data.platforms || [];
          }
        } catch {
          // Fallback: no platform data, still generate post
        }
      }
    } else {
      artistType = 'prominent';
      const picked = pickArtist(prominentPool, history);
      if (picked) {
        artist = picked;
        const data = loadArtistData(picked.slug);
        if (data) platforms = data.platforms;
      }
    }

    if (!artist) {
      console.log(`  Day ${day} (${date}): No ${isIndie ? 'indie' : 'prominent'} artist available — skipping`);
      continue;
    }

    // Mark as featured
    if (!history.featured.includes(artist.slug)) {
      history.featured.push(artist.slug);
    }

    const highlightPlatforms = platforms
      .filter(p => HIGHLIGHT_PLATFORMS.has(p.sourceId) && !p.url.includes('duckduckgo'))
      .map(p => PLATFORM_NAMES[p.sourceId] || p.sourceId);

    const rawRelease = platforms
      .map(p => p.latestRelease)
      .filter(Boolean)
      .sort((a, b) => {
        const dateA = a?.releaseDate ? new Date(a.releaseDate).getTime() : 0;
        const dateB = b?.releaseDate ? new Date(b.releaseDate).getTime() : 0;
        return dateB - dateA;
      })[0];

    const cleanedTitle = rawRelease
      ? cleanReleaseTitle(rawRelease.title, artist.name)
      : null;

    const socialHandles = extractSocialHandles(platforms);
    const posts = generateDrafts(artist, artistType, platforms, day, socialHandles);

    const draft: PostDraft = {
      day,
      date,
      artistType,
      artistName: artist.name,
      artistSlug: artist.slug,
      unstreamUrl: artistType === 'indie'
        ? `${UNSTREAM_BASE}/a/${artist.slug}`
        : `${UNSTREAM_BASE}/artist/${artist.slug}`,
      imageUrl: artist.imageUrl,
      platforms: highlightPlatforms,
      latestRelease: cleanedTitle ? `${cleanedTitle} (${rawRelease!.type})` : null,
      socialHandles,
      posts,
    };

    drafts.push(draft);

    const typeIcon = artistType === 'indie' ? '🎸' : '🎵';
    console.log(`  ${typeIcon} ${DAY_NAMES[day - 1]} ${date}: ${artist.name} (${artistType})`);

    // Write individual day markdown
    writeFileSync(join(weekDir, `day-${day}.md`), draftToMarkdown(draft));
  }

  // Write full week JSON
  writeFileSync(join(weekDir, 'drafts.json'), JSON.stringify(drafts, null, 2));
  saveHistory(history);

  console.log(`\n✓ Drafts written to ${weekDir}/`);
  console.log(`  - ${drafts.length} day files (day-N.md)`);
  console.log(`  - drafts.json (machine-readable)`);

  // --- Schedule to Buffer ---
  if (doSchedule) {
    const token = process.env.BUFFER_ACCESS_TOKEN;
    const channelIdsStr = process.env.BUFFER_CHANNEL_IDS;

    if (!token) {
      console.error('\n✗ BUFFER_ACCESS_TOKEN not set. Cannot schedule.');
      process.exit(1);
    }
    if (!channelIdsStr) {
      console.error('\n✗ BUFFER_CHANNEL_IDS not set. Run with --channels to find your IDs.');
      console.error('  Set as: BUFFER_CHANNEL_IDS=threads_id,bluesky_id,instagram_id');
      process.exit(1);
    }

    const [threadsId, blueskyId, instagramId] = channelIdsStr.split(',');
    const saveToDraft = !doPublish;

    if (saveToDraft) {
      console.log('\nPushing to Buffer as DRAFTS (review in Buffer dashboard before publishing)...\n');
    } else {
      console.log('\nScheduling to Buffer for PUBLICATION...\n');
    }

    for (const draft of drafts) {
      // Schedule at 12:00 PM ET each day
      const dueAt = `${draft.date}T13:00:00Z`; // 8 AM ET = 1 PM UTC

      const results = [];

      if (threadsId) {
        const result = await createBufferPost({
          channelId: threadsId,
          text: draft.posts.threads,
          dueAt,
          imageUrl: draft.imageUrl,
          saveToDraft,
          metadata: { threads: { topic: 'Music Threads' } },
        });
        results.push({ platform: 'Threads', ...result });
      }
      if (blueskyId) {
        const result = await createBufferPost({
          channelId: blueskyId,
          text: draft.posts.bluesky,
          dueAt,
          imageUrl: draft.imageUrl,
          saveToDraft,
        });
        results.push({ platform: 'Bluesky', ...result });
      }
      if (instagramId) {
        // Instagram requires an image — use placeholder + save as draft if none available
        const hasImage = !!draft.imageUrl;
        const igImage = draft.imageUrl || `${UNSTREAM_BASE}/og-image.png`;
        const result = await createBufferPost({
          channelId: instagramId,
          text: draft.posts.instagram,
          dueAt,
          imageUrl: igImage,
          saveToDraft,
          metadata: { instagram: { type: 'post', shouldShareToFeed: true } },
        });
        if (!hasImage && result.success) {
          result.status = 'draft (needs image)';
        }
        results.push({ platform: 'Instagram', ...result });
      }

      const ok = results.every(r => r.success);
      console.log(`  ${ok ? '✓' : '⚠'} ${draft.date} — ${draft.artistName}`);
      for (const r of results) {
        const label = r.success ? `✓ ${r.status || 'ok'}` : `✗ ${r.error}`;
        console.log(`    ${label} — ${r.platform}${r.id ? ` (${r.id})` : ''}`);
      }
    }

    if (saveToDraft) {
      console.log('\n✓ Drafts pushed to Buffer. Review and approve them in the Buffer dashboard.');
      console.log('  To schedule directly instead: add --publish flag.\n');
    } else {
      console.log('\n✓ Posts scheduled for publication.\n');
    }
  } else {
    console.log('\nReview the drafts, then push to Buffer as drafts:');
    console.log(`  npx tsx scripts/generate-social-posts.ts --week ${week} --schedule\n`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
