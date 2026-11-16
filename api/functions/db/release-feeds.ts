// Release feeds (calendar and RSS): feed tokens, and the releases for a fan, an artist or a
// public handle.

import { artistSlug } from '../../shared/artist-slug';
import { getClient, readAllPages } from './client';

// --- Release feeds (/feed/f/{token}.ics) ---

/**
 * Look up whose feed this token is.
 *
 * The token *is* the authorization — a calendar client sends no session — so this is the whole
 * auth check for the feed path. Returns null for an unknown token, which the caller must turn
 * into a 404 rather than a 401: a 401 invites retrying with a different token, and confirming
 * "this token shape exists but is wrong" is more than an anonymous caller needs to know.
 *
 * Never log the token. It's a credential in a URL, and path tokens end up in access logs and
 * referrers by default (spec §8).
 */
export async function getFeedTokenOwner(token: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('release_feed_tokens')
      .select('user_id')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      console.error('[DB] getFeedTokenOwner failed:', error.message);
      return null;
    }
    return data ? (data as { user_id: string }).user_id : null;
  } catch (error) {
    console.error('[DB] getFeedTokenOwner error:', error);
    return null;
  }
}

/** The user's existing feed token, or null if they've never made one. */
export async function getFeedToken(userId: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('release_feed_tokens')
      .select('token')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[DB] getFeedToken failed:', error.message);
      return null;
    }
    return data ? (data as { token: string }).token : null;
  } catch (error) {
    console.error('[DB] getFeedToken error:', error);
    return null;
  }
}

/**
 * Issue a feed token, replacing any existing one.
 *
 * Upsert on `user_id` rather than insert-then-delete, so rotation is a single statement and
 * there is never a window where the user has no token at all. The caller generates the value —
 * `crypto.randomBytes` lives at the endpoint, keeping this module free of the "how much entropy"
 * decision.
 */
export async function setFeedToken(userId: string, token: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { error } = await client
      .from('release_feed_tokens')
      .upsert(
        { user_id: userId, token, rotated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );

    if (error) {
      console.error('[DB] setFeedToken failed:', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[DB] setFeedToken error:', error);
    return false;
  }
}

/** Revoke the user's feed token entirely, breaking every existing subscription. */
export async function deleteFeedToken(userId: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { error } = await client.from('release_feed_tokens').delete().eq('user_id', userId);
    if (error) {
      console.error('[DB] deleteFeedToken failed:', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[DB] deleteFeedToken error:', error);
    return false;
  }
}

export interface FeedReleaseRow {
  artistName: string;
  artistSlug: string;
  title: string;
  releaseSlug: string;
  releaseDate: string;
  /**
   * How precisely `releaseDate` is actually known. MusicBrainz gives year- and month-only dates,
   * and the dashboard prints the date in words — so it needs this to avoid claiming "1 January
   * 2023" for a release we only know the year of. The feeds place an event *on* the date and
   * have nothing finer to say, so they ignore it.
   */
  datePrecision: string | null;
  offerSummary: string;
  platforms: string[];
  /** Cover art, so a feed entry can show the record rather than just name it. */
  artworkUrl: string | null;
  sources: {
    platform: string;
    /** The platform's own page. Feed entries link each platform rather than listing dead names. */
    url: string;
    offers: { price: number | null; currency: string | null; availability: string }[];
  }[];
}

/**
 * How far back a feed reaches. Spec §3 argues for upcoming releases only ("a calendar of past
 * releases is a changelog"), and that argument is right about the *back catalogue* — but a
 * record that came out last week is still something a subscriber may not have bought yet, which
 * is the same purchase-intent moment the alerts serve. A short trailing window keeps that case
 * and stops the feed reading as broken while catalog coverage is still thin.
 */
export const FEED_TRAILING_DAYS = 30;

/** Cap on events in one feed, so a fan with hundreds of saved artists still gets a usable file. */
const FEED_MAX_RELEASES = 200;

// Every feed read below is ordered by date, and `releases.display_order` deliberately does not
// apply to any of them. A calendar is keyed on dates and a reader sorts an Atom feed by them, so
// an artist's page arrangement has nothing to say here — the same line drawn for alerts above.

type FeedQueryRow = {
  slug: string;
  title: string;
  release_date: string | null;
  date_precision: string | null;
  artwork_url: string | null;
  artists: { name: string; slug: string } | null;
  release_sources: {
    platform: string;
    url: string;
    release_offers: { price: number | null; currency: string | null; availability: string }[] | null;
  }[] | null;
};

function toFeedRows(rows: FeedQueryRow[]): FeedReleaseRow[] {
  return rows
    .filter(r => r.release_date && r.artists)
    .map(r => ({
      artistName: r.artists!.name,
      artistSlug: r.artists!.slug,
      title: r.title,
      releaseSlug: r.slug,
      releaseDate: r.release_date!,
      datePrecision: r.date_precision,
      offerSummary: '',
      platforms: [],
      artworkUrl: r.artwork_url,
      sources: (r.release_sources || []).map(s => ({
        platform: s.platform,
        url: s.url,
        offers: s.release_offers || [],
      })),
    }));
}

const FEED_SELECT =
  'slug, title, release_date, date_precision, artwork_url, artists!inner ( name, slug ),' +
  ' release_sources ( platform, url, release_offers ( price, currency, availability ) )';

/** Soonest first — a calendar and a reader both want the next thing at the top. */
function feedSince(now: Date): string {
  return new Date(now.getTime() - FEED_TRAILING_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Resolve the artists this user has saved, to artist-table ids.
 *
 * **`saved_artists.artist_id` alone is not enough, and assuming it was is how the dashboard
 * shipped empty.** The column is populated only when the save request's slug matched an artists
 * row at the time; a save made from a search result used to send a synthetic key
 * (`rodneyowl`, `qobuz-pearljam`, `nameonly-…`), which matched nothing, so the row was written
 * with `artist_id: null`. Measured 2026-08-07: **25 of 37 live rows**. Every feature keyed on
 * `artist_id` — this feed, the /my-collection shortlist — was silently blind to two thirds of
 * everyone's saved artists.
 *
 * The client that wrote those keys is fixed, but the rows are already in the database and a
 * fan's calendar should not stay wrong until a backfill runs. So `artist_slug` is resolved as a
 * fallback here, through the same alias table the artist page uses, since a slug retired by the
 * accent-folding reslug (#410) is the other way a stored slug stops matching.
 *
 * `deleted = false` matters as much: `saved_artists` uses tombstones (migration 017), so without
 * it an artist you *unsaved* keeps feeding your calendar forever.
 */
async function savedArtistIdsForUser(
  client: NonNullable<ReturnType<typeof getClient>>,
  userId: string
): Promise<string[] | null> {
  const { data: saved, error: savedError } = await client
    .from('saved_artists')
    .select('artist_id, artist_slug, artist_name')
    .eq('user_id', userId)
    .eq('deleted', false);

  if (savedError) {
    console.error('[DB] savedArtistIdsForUser read failed:', savedError.message);
    return null;
  }

  const rows = (saved as { artist_id: string | null; artist_slug: string | null; artist_name: string | null }[]) || [];
  const ids = new Set<string>();
  const unresolved: { slug: string; name: string | null }[] = [];

  for (const row of rows) {
    if (row.artist_id) ids.add(row.artist_id);
    else if (row.artist_slug) unresolved.push({ slug: row.artist_slug.toLowerCase(), name: row.artist_name });
  }
  if (unresolved.length === 0) return [...ids];

  // Two candidates per row, because the stored slugs are two different kinds of wrong.
  //
  // The stored slug itself covers a *retired* slug (the accent-folding reslug, #410 — 44 aliases
  // exist), and is tried against the alias table below.
  //
  // `artistSlug(artist_name)` covers the synthetic search keys, which is what the rows actually
  // hold: measured on production, **not one** unlinked slug matched an artists row or an alias
  // directly — they are squashed names (`rodneyowl`, `seoulmetro`, `modelactriz`) and prefixed
  // platform keys (`qobuz-robertlogan`). Re-deriving from the name is the only thing that
  // recovers them, and it is the same expression `persistSearchResults` upserts the artist under,
  // so it names a row that exists rather than guessing at one.
  const candidates = new Set<string>();
  for (const row of unresolved) {
    candidates.add(row.slug);
    if (row.name) candidates.add(artistSlug(row.name));
  }

  // One `.in()` is safe without chunking here in a way it usually isn't: this is one person's
  // saved list, not a table scan. The PostgREST 1,000-row cap is nowhere near.
  //
  // The alias read is only *used* for slugs the artists read leaves unmatched, but it is asked
  // for every unresolved slug and sent at the same time, so the dashboard waits on one round trip
  // here instead of two in a row. The extra rows it can return are a handful of tiny ones.
  const [{ data: bySlug, error: slugError }, { data: aliased, error: aliasError }] = await Promise.all([
    client
      .from('artists')
      .select('id, slug, name')
      .in('slug', [...candidates]),
    client
      .from('artist_slug_aliases')
      .select('artist_id, alias')
      .in('alias', unresolved.map(row => row.slug)),
  ]);

  if (slugError) {
    // Reported rather than swallowed: returning the partial set would look exactly like "those
    // artists have nothing new", which is the confusion this whole function exists to stop. The
    // ids we did resolve are still returned — they are not in doubt.
    console.error('[DB] savedArtistIdsForUser slug resolution failed:', slugError.message);
    return [...ids];
  }

  const artistsBySlug = new Map<string, { id: string; name: string }>();
  for (const row of (bySlug as { id: string; slug: string; name: string }[]) || []) {
    artistsBySlug.set(row.slug.toLowerCase(), { id: row.id, name: row.name });
  }

  const stillUnmatched: string[] = [];
  for (const row of unresolved) {
    // An exact slug match is accepted outright — the saved row named this artist's page.
    const direct = artistsBySlug.get(row.slug);
    if (direct) {
      ids.add(direct.id);
      continue;
    }

    // A name-derived match has to prove itself, because a name is a much weaker key than a slug.
    // Requiring the found artist's own name to normalize identically stops a saved row with a
    // generic or wrong name ("Music") from silently adopting an unrelated artist's releases —
    // which would put someone else's record in a fan's calendar, a worse failure than showing
    // nothing.
    const derived = row.name ? artistSlug(row.name) : '';
    const byName = derived ? artistsBySlug.get(derived) : undefined;
    if (byName && artistSlug(byName.name) === derived) {
      ids.add(byName.id);
      continue;
    }

    stillUnmatched.push(row.slug);
  }

  if (stillUnmatched.length > 0) {
    if (aliasError) {
      console.error('[DB] savedArtistIdsForUser alias resolution failed:', aliasError.message);
    } else {
      const wanted = new Set(stillUnmatched);
      for (const row of (aliased as { artist_id: string; alias: string }[]) || []) {
        if (wanted.has(row.alias)) ids.add(row.artist_id);
      }
    }
  }

  return [...ids];
}

/** Slugs per artists lookup — keeps each response far below PostgREST's 1,000-row cap. */
const ARTIST_SLUG_LOOKUP_CHUNK = 100;

/** Slug lookups in flight at once: 500 collection artists in one round trip, and no more. */
const CONCURRENT_SLUG_LOOKUPS = 5;

/**
 * The artists a fan owns a record by, resolved to artist ids.
 *
 * `collection_items` stores the artist as the source spelled it, not a foreign key, so this
 * resolves two ways: exactly, through a matched release's `artist_id`, and otherwise by
 * deriving the slug with `artistSlug()` — the same key every other writer uses. Around 72% of a
 * real import matches no release, so the slug path is the common one, not the fallback.
 * Artists that resolve neither way simply contribute nothing.
 *
 * A read failure returns an empty list rather than null: the collection is an *addition* to the
 * saved-artist feed, so failing here should quietly narrow the feed, never blank it.
 */
async function collectionArtistIdsForUser(
  client: NonNullable<ReturnType<typeof getClient>>,
  userId: string
): Promise<string[]> {
  const read = await readAllPages<{ artist_name: string | null; releases: { artist_id: string } | null }>(
    (from, to) =>
      client
        .from('collection_items')
        .select('artist_name, releases!left (artist_id)')
        .eq('user_id', userId)
        .range(from, to),
    'collection_items (feed)'
  );
  if (!read.ok) return [];

  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const row of read.rows) {
    if (row.releases?.artist_id) {
      ids.add(row.releases.artist_id);
      continue;
    }
    if (!row.artist_name) continue;
    const slug = artistSlug(row.artist_name);
    if (slug) slugs.add(slug);
  }
  if (slugs.size === 0) return [...ids];

  // Chunked, unlike the saved-artist lookup above: a collection is a whole record library, not
  // a shortlist, so this one really can approach PostgREST's 1,000-row cap. Up to
  // CONCURRENT_SLUG_LOOKUPS chunks are sent at once rather than one after another, so a typical
  // collection costs the dashboard one round trip here instead of one per hundred artists, while
  // a huge one can't open dozens of simultaneous requests against the small database. Results are
  // still read in order and stop at the first failed chunk, as the sequential loop did.
  const pending = [...slugs];
  const chunks: string[][] = [];
  for (let i = 0; i < pending.length; i += ARTIST_SLUG_LOOKUP_CHUNK) {
    chunks.push(pending.slice(i, i + ARTIST_SLUG_LOOKUP_CHUNK));
  }
  let failed = false;
  for (let i = 0; i < chunks.length && !failed; i += CONCURRENT_SLUG_LOOKUPS) {
    const lookups = await Promise.all(
      chunks.slice(i, i + CONCURRENT_SLUG_LOOKUPS).map(chunk =>
        client.from('artists').select('id').in('slug', chunk)
      )
    );
    for (const { data, error } of lookups) {
      if (error) {
        console.error('[DB] collectionArtistIdsForUser slug resolution failed:', error.message);
        failed = true;
        break;
      }
      for (const row of (data as { id: string }[]) || []) ids.add(row.id);
    }
  }

  return [...ids];
}

/**
 * Every release worth putting in one fan's feed: across their saved artists *and* the artists
 * in their collection, dated within the trailing window or still to come.
 *
 * Two exclusions match the alert path for the same reasons — hidden releases are suppressed by
 * an artist and must stay invisible, and a `needs_review` tier-3 fuzzy flag means we aren't sure
 * the release is distinct, which is not something to publish into someone's calendar.
 */
export async function getFeedReleasesForUser(userId: string, now: Date = new Date()): Promise<FeedReleaseRow[]> {
  const client = getClient();
  if (!client) return [];

  try {
    // Saved artists AND artists you own a record by. Buying somebody's album says at least as
    // much about wanting their next one as saving them does — but the two lists stay separate
    // everywhere else, because saving is deliberate and an import is not (spec OQ6, reversed
    // 2026-08-16). The Bandcamp import used to conscript matched artists into saved_artists,
    // which is what made their releases show up at all; this union is what keeps that promise
    // now that it doesn't.
    //
    // The two lists don't depend on each other, so they resolve at the same time: the dashboard
    // waits for the slower of the two chains, not both end to end.
    const [savedIds, collectionIds] = await Promise.all([
      savedArtistIdsForUser(client, userId),
      collectionArtistIdsForUser(client, userId),
    ]);
    if (savedIds === null) return [];
    const artistIds = [...new Set([...savedIds, ...collectionIds])];
    if (artistIds.length === 0) return [];

    const { data, error } = await client
      .from('releases')
      .select(FEED_SELECT)
      .in('artist_id', artistIds)
      .eq('is_hidden', false)
      .eq('needs_review', false)
      .gte('release_date', feedSince(now))
      .order('release_date', { ascending: true })
      .limit(FEED_MAX_RELEASES);

    if (error) {
      console.error('[DB] getFeedReleasesForUser read failed:', error.message);
      return [];
    }

    return toFeedRows((data as unknown as FeedQueryRow[]) || []);
  } catch (error) {
    console.error('[DB] getFeedReleasesForUser error:', error);
    return [];
  }
}

/**
 * One artist's feed, for the public `/a/{slug}/releases.{xml,ics}`.
 *
 * **Deliberately unwindowed, unlike the per-fan and per-handle feeds above.** Those are a
 * calendar of what's coming across everything you follow, where a trailing window keeps the
 * thing usable. An artist feed is a different object: it is that artist's *discography*, and
 * someone subscribing to it wants the back catalogue, not just whatever happens to be imminent.
 * Brandon, on his own artist feed: *"It really should include everything - not just upcoming
 * ones."*
 *
 * Ordered newest-first rather than soonest-first, which is both the RSS convention and the safe
 * pairing with `FEED_MAX_RELEASES`: an ascending order plus a cap would silently drop an artist's
 * *recent* work in favour of their oldest.
 */
export async function getFeedReleasesForArtist(
  artistSlugValue: string,
  _now: Date = new Date()
): Promise<{ artistName: string; releases: FeedReleaseRow[] } | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data: artist, error: artistError } = await client
      .from('artists')
      .select('id, name')
      .eq('slug', artistSlugValue)
      .maybeSingle();

    if (artistError || !artist) return null;
    const { id, name } = artist as { id: string; name: string };

    const { data, error } = await client
      .from('releases')
      .select(FEED_SELECT)
      .eq('artist_id', id)
      .eq('is_hidden', false)
      .eq('needs_review', false)
      // No date floor: the whole catalogue, past and upcoming. `not.is.null` because an undated
      // release has no event to place in a calendar and no meaningful position in a feed —
      // `toFeedRows` drops those anyway, so excluding them here stops them eating the cap.
      .not('release_date', 'is', null)
      .order('release_date', { ascending: false })
      .limit(FEED_MAX_RELEASES);

    if (error) {
      console.error('[DB] getFeedReleasesForArtist read failed:', error.message);
      return null;
    }

    return { artistName: name, releases: toFeedRows((data as unknown as FeedQueryRow[]) || []) };
  } catch (error) {
    console.error('[DB] getFeedReleasesForArtist error:', error);
    return null;
  }
}

/**
 * This account's username, only while their list at /u/{handle} is public — otherwise null.
 *
 * For curator posts, whose Instagram caption points at that page. Gated on the same opt-in as the
 * page itself, so a caption never sends people to a 404.
 */
export async function getPublicUsername(userId: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from('usernames')
    .select('username, saved_artists_public')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  const row = data as { username: string; saved_artists_public: boolean } | null;
  return row?.saved_artists_public ? row.username : null;
}

/**
 * The public feed for a shared list at /u/{handle}.
 *
 * Gated on the same opt-in the HTML page uses (`usernames.saved_artists_public`) — a handle
 * existing is not consent to publish that person's subscriptions as a calendar. Returns null
 * when the handle is unknown *or* not shared, so the caller 404s either way and the feed can't
 * be used to probe which handles exist.
 */
export async function getFeedReleasesForHandle(
  handle: string,
  now: Date = new Date()
): Promise<{ displayName: string; releases: FeedReleaseRow[] } | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data: row, error } = await client
      .from('usernames')
      .select('user_id, username, saved_artists_public')
      .eq('username', handle.toLowerCase())
      .maybeSingle();

    if (error || !row) return null;
    const username = row as { user_id: string; username: string; saved_artists_public: boolean };
    if (!username.saved_artists_public) return null;

    return {
      displayName: username.username,
      releases: await getFeedReleasesForUser(username.user_id, now),
    };
  } catch (error) {
    console.error('[DB] getFeedReleasesForHandle error:', error);
    return null;
  }
}
