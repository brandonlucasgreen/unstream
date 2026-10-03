/**
 * Where the weekly industry digest looks for news. Edit freely — this is the one file to touch
 * when a feed dies or a new beat matters.
 *
 * Feeds carry dates, so they are the backbone. Web searches (Ollama's web_search API, up to 10
 * results each) catch what the feeds miss — mostly the smaller platforms Unstream covers, which
 * the trade press rarely writes about — but come back undated, so the model is told to keep a
 * search result only if its text shows it is from this week.
 *
 * A feed that fails to fetch or parse is reported as a warning in the run summary and the run
 * carries on; it only fails when every feed does.
 */

export interface FeedSource {
  name: string;
  url: string;
}

export const FEEDS: FeedSource[] = [
  { name: 'Music Business Worldwide', url: 'https://www.musicbusinessworldwide.com/feed/' },
  { name: 'Digital Music News', url: 'https://www.digitalmusicnews.com/feed/' },
  { name: 'Hypebot', url: 'https://www.hypebot.com/feed/' },
  { name: 'Music Ally', url: 'https://musically.com/feed/' },
  { name: 'CMU', url: 'https://completemusicupdate.com/feed/' },
  { name: 'Billboard Business', url: 'https://www.billboard.com/c/business/feed/' },
  { name: 'Bandcamp Daily', url: 'https://daily.bandcamp.com/feed' },
  { name: 'Pitchfork News', url: 'https://pitchfork.com/feed/feed-news/rss' },
  { name: 'Water & Music', url: 'https://www.waterandmusic.com/rss/' },
  { name: '404 Media', url: 'https://www.404media.co/rss/' },
];

export const SEARCH_QUERIES: string[] = [
  'Bandcamp news this week',
  'Spotify artist royalties payouts news this week',
  'music streaming payouts independent artists news',
  'AI generated music streaming platform policy news',
  'new direct-to-fan music platform launch',
  'Mirlo Ampwall Subvert Faircamp music platform news',
  'Patreon musicians creators news this week',
  'music industry law policy independent artists this week',
];
