// Shared bot detection for edge functions that must serve real browsers the SPA (so a direct
// load renders exactly the same UI as client-side navigation — see docs/retros/UNS-100-bifurcation-retro.md)
// while still handing crawlers a fully populated, no-JS-required HTML page for SEO/link previews.

// Social media crawlers: don't execute JS, only need OG/Twitter meta tags for link previews.
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

// Indexing crawlers: need real page content, not just meta tags.
const INDEXING_CRAWLERS = [
  'Googlebot',
  'bingbot',
  'YandexBot',
  'DuckDuckBot',
  'Baiduspider',
];

export function isSocialCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return SOCIAL_CRAWLER_USER_AGENTS.some(crawler => ua.includes(crawler.toLowerCase()));
}

export function isIndexingCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return INDEXING_CRAWLERS.some(crawler => ua.includes(crawler.toLowerCase()));
}
