// Reading releases for display: an artist page's list, one release's buying guide, and the
// releases an alert run considers.

import { artistSlug } from '../../shared/artist-slug';
import { oneSourcePerPlatform } from '../../shared/release-display';
import { getClient } from './client';

// --- Releases for an artist page ---

export interface ArtistPageRelease {
  slug: string;
  title: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string | null;
  status: string;
  artworkUrl: string | null;
  // Platform attribution kept per-source (not flattened) so the UI can show *where* a release
  // is available, not just the cheapest number across everywhere it happens to be sold.
  sources: { platform: string; offers: { price: number | null; currency: string | null; availability: string }[] }[];
}

/**
 * An artist's releases for their page, in the artist's order where they set one and newest
 * first otherwise, plus the total.
 *
 * `count: 'exact'` rides along with the limit in one round trip, so an "and N more" line is a
 * real number rather than a guess. The chronological part of the ordering matches
 * idx_releases_artist_chrono: many releases have no date yet — grid ingest gets identity and
 * artwork but no dates — and without the created_at tiebreaker those undated rows would shuffle
 * between requests.
 *
 * `display_order` leads, NULLS LAST: it's null for every release until a claimed artist arranges
 * their catalogue on /releases/:slug, so this is unchanged behaviour for everyone
 * else. Sorted in SQL rather than after the fetch on purpose — re-sorting a date-limited page in
 * JS would drop a release the artist had pinned to the top out of the query entirely.
 *
 * Hidden releases are filtered in the query rather than after, so a suppressed release is
 * indistinguishable from one that was never catalogued. That's the point of the column.
 */
export async function getArtistReleases(
  artistId: string,
  limit: number
): Promise<{ releases: ArtistPageRelease[]; total: number }> {
  return readArtistPageReleases({ artistId }, limit);
}

/**
 * The same releases, found by the artist's slug instead of their id.
 *
 * This is what lets /api/artist-page read the releases *alongside* the artist row rather than
 * after it: the slug is in the URL, the id only arrives with the row. The `artists!inner` embed
 * turns the slug into a filter on the releases themselves (and on the count), so the result is
 * identical to `getArtistReleases` for the artist holding that slug, and empty for a slug nobody
 * holds.
 */
export async function getArtistReleasesBySlug(
  slug: string,
  limit: number
): Promise<{ releases: ArtistPageRelease[]; total: number }> {
  return readArtistPageReleases({ slug }, limit);
}

async function readArtistPageReleases(
  artist: { artistId: string } | { slug: string },
  limit: number
): Promise<{ releases: ArtistPageRelease[]; total: number }> {
  const client = getClient();
  if (!client) return { releases: [], total: 0 };

  try {
    const select =
      'slug, title, release_type, release_date, date_precision, status, artwork_url,' +
      ' release_sources ( platform, release_offers ( price, currency, availability ) )';
    const query = 'artistId' in artist
      ? client.from('releases').select(select, { count: 'exact' }).eq('artist_id', artist.artistId)
      : client.from('releases').select(`${select}, artists!inner ( slug )`, { count: 'exact' }).eq('artists.slug', artist.slug);

    const { data, count, error } = await query
      .eq('is_hidden', false)
      .order('display_order', { ascending: true, nullsFirst: false })
      .order('release_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[DB] getArtistReleases failed:', error.message);
      return { releases: [], total: 0 };
    }

    type Row = {
      slug: string;
      title: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      status: string;
      artwork_url: string | null;
      release_sources: {
        platform: string;
        release_offers: { price: number | null; currency: string | null; availability: string }[] | null;
      }[] | null;
    };

    // Through `unknown`: PostgREST types a nested select as a union that includes an error
    // shape, so a direct cast is rejected. The runtime shape is checked by the query above.
    const releases = ((data as unknown as Row[]) || []).map(r => ({
      slug: r.slug,
      title: r.title,
      releaseType: r.release_type,
      releaseDate: r.release_date,
      datePrecision: r.date_precision,
      status: r.status,
      artworkUrl: r.artwork_url,
      sources: (r.release_sources || []).map(s => ({ platform: s.platform, offers: s.release_offers || [] })),
    }));

    return { releases, total: count ?? releases.length };
  } catch (error) {
    console.error('[DB] getArtistReleases error:', error);
    return { releases: [], total: 0 };
  }
}

// --- One release's buying guide ---

/** One format on one platform: what it is, what it costs, and whether you can still get it. */
export interface ReleaseDetailOffer {
  format: string;
  price: number | null;
  currency: string | null;
  availability: string;
  capturedAt: string;
}

export interface ReleaseDetailSource {
  platform: string;
  /** The platform's own page for this release — where "Buy" actually goes. */
  url: string;
  /** When this platform's page was last read for prices. Null means never, which is not the
   *  same as "it has no formats" — the caller has to be able to tell those apart. */
  detailCheckedAt: string | null;
  offers: ReleaseDetailOffer[];
}

export interface ReleaseDetail {
  artist: { slug: string; name: string; imageUrl: string | null };
  release: {
    slug: string;
    title: string;
    releaseType: string;
    releaseDate: string | null;
    datePrecision: string | null;
    status: string;
    artworkUrl: string | null;
    sources: ReleaseDetailSource[];
  };
}

/**
 * Three outcomes, deliberately distinguishable, for the same reason `getArtistProfileBySlug`
 * distinguishes them: a caller that can't tell "no such release" from "the database didn't
 * answer" turns a Supabase outage into a wall of convincing 404s.
 *   { detail }           — found
 *   { detail: null }     — no such artist, or no such (visible) release under them
 *   { failed: true }     — the lookup itself failed
 */
export interface ReleaseDetailLookup {
  detail: ReleaseDetail | null;
  failed: boolean;
}

/**
 * Everything the buying guide for one release needs — the same query
 * `api/edge/release-page.ts` runs, because this is that page's JSON twin and a native client
 * must not describe a release differently from the web page at the same URL.
 *
 * Two filters, and the asymmetry between them is the point:
 *   - `is_hidden` is filtered, in the query rather than after, so a release an artist has
 *     deliberately suppressed is indistinguishable from one that was never catalogued.
 *   - `needs_review` is deliberately **not** filtered, unlike the alert and feed reads. A
 *     tier-3 fuzzy flag means "we aren't sure this release is *distinct*", not "this is
 *     wrong". That's a good reason to keep it out of someone's calendar and a bad reason to
 *     404 a person who followed a direct link to it.
 *
 * Ordering is left to the caller: sorting by payout needs the platform registry, which this
 * data layer deliberately knows nothing about.
 */
export async function getReleaseDetail(
  artistSlugValue: string,
  releaseSlugValue: string
): Promise<ReleaseDetailLookup> {
  const client = getClient();
  // Missing credentials mean we can't answer, not that the release doesn't exist.
  if (!client) return { detail: null, failed: true };

  try {
    const { data: artist, error: artistError } = await client
      .from('artists')
      .select('id, name, image_url')
      .eq('slug', artistSlugValue)
      .maybeSingle();

    if (artistError) {
      console.error('[DB] getReleaseDetail artist read failed:', artistError.message);
      return { detail: null, failed: true };
    }
    if (!artist) return { detail: null, failed: false };
    const artistRow = artist as { id: string; name: string; image_url: string | null };

    // One round trip for the release, its sources and their offers. Scoped by `artist_id`
    // rather than by joining on the artist slug, because a release slug is only unique per
    // artist — two artists can each have a `self-titled`.
    const { data, error } = await client
      .from('releases')
      .select(
        'slug, title, release_type, release_date, date_precision, status, artwork_url,' +
        ' release_sources ( platform, url, source, detail_checked_at,' +
        ' release_offers ( format, price, currency, availability, captured_at ) )'
      )
      .eq('artist_id', artistRow.id)
      .eq('slug', releaseSlugValue)
      .eq('is_hidden', false)
      .maybeSingle();

    if (error) {
      console.error('[DB] getReleaseDetail release read failed:', error.message);
      return { detail: null, failed: true };
    }
    if (!data) return { detail: null, failed: false };

    type Row = {
      slug: string;
      title: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      status: string;
      artwork_url: string | null;
      release_sources: {
        platform: string;
        url: string;
        source: string | null;
        detail_checked_at: string | null;
        release_offers: {
          format: string;
          price: number | null;
          currency: string | null;
          availability: string;
          captured_at: string;
        }[] | null;
      }[] | null;
    };

    // Through `unknown`: PostgREST types a nested select as a union that includes an error
    // shape, so a direct cast is rejected. The runtime shape is checked by the query above.
    const row = data as unknown as Row;

    return {
      detail: {
        artist: { slug: artistSlugValue, name: artistRow.name, imageUrl: artistRow.image_url },
        release: {
          slug: row.slug,
          title: row.title,
          releaseType: row.release_type,
          releaseDate: row.release_date,
          datePrecision: row.date_precision,
          status: row.status,
          artworkUrl: row.artwork_url,
          // One row per platform, matching the edge page exactly — this is that page's JSON
          // twin, and a release an admin merged out of two Discogs masters must not describe
          // itself differently to a native client than it does on the web.
          sources: oneSourcePerPlatform(row.release_sources || []).map(s => ({
            platform: s.platform,
            url: s.url,
            detailCheckedAt: s.detail_checked_at,
            offers: (s.release_offers || []).map(o => ({
              format: o.format,
              price: o.price,
              currency: o.currency,
              availability: o.availability,
              capturedAt: o.captured_at,
            })),
          })),
        },
      },
      failed: false,
    };
  } catch (error) {
    console.error('[DB] getReleaseDetail error:', error);
    return { detail: null, failed: true };
  }
}

// --- Releases for alerts ---

export interface AlertRelease {
  /** Release slug, for building the /a/{artist}/{release} link an alert points at. */
  slug: string;
  title: string;
  releaseDate: string | null;
  datePrecision: string | null;
  status: string;
  artworkUrl: string | null;
  sources: {
    platform: string;
    /** The platform's own page for this release — the fallback link when a fan wants the source. */
    url: string;
    offers: { price: number | null; currency: string | null; availability: string }[];
  }[];
}

export interface AlertReleases {
  /** The catalogued artist's slug, which may differ from the caller's derived one. */
  artistSlug: string;
  releases: AlertRelease[];
}

/**
 * Everything an alert needs for one artist, straight out of the catalog.
 *
 * **Returns null when this artist has no catalog at all, and `[]` when they have one with
 * nothing new in it.** Those are different facts and the caller depends on the difference: the
 * first means "we haven't looked yet, go and scrape" and the second means "we looked and there
 * is genuinely nothing". Collapsing them into an empty array is the single most repeated bug
 * class in this codebase, and here it would either silently stop alerting for every artist
 * without a catalog, or re-scrape Bandcamp for every artist forever.
 *
 * The window is a floor, not a range. Anything dated on or after `today - windowDays` qualifies,
 * **including releases dated in the future** — which is the whole point of the fix. The old
 * client-side check required `daysDiff >= 0`, so a pre-announced record was filtered out for
 * being in the future and then aged past the window before it ever became "recent"; the most
 * delightful possible alert ("your artist just announced an album for September") could not fire
 * at all. Undated releases are excluded: with no date there is nothing to say is new, and grid
 * ingest produces plenty of them.
 *
 * Strictly chronological, and `releases.display_order` deliberately does not apply — that's not
 * an oversight. An artist's manual arrangement answers "what should fans see first on my page";
 * an alert answers "what came out". Honouring the arrangement here would let a pinned back
 * catalogue release be announced as the new one, and `release[0]` — which the shipped Mac app
 * and extension read as *the* new release — would stop meaning newest.
 */
export async function getReleasesForAlerts(
  artistName: string,
  windowDays: number,
  now: Date = new Date()
): Promise<AlertReleases | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data: artist, error: artistError } = await client
      .from('artists')
      .select('id, slug')
      .eq('slug', artistSlug(artistName))
      .maybeSingle();

    if (artistError) {
      console.error('[DB] getReleasesForAlerts artist lookup failed:', artistError.message);
      return null;
    }
    if (!artist) return null;

    const { id, slug } = artist as { id: string; slug: string };

    // Has this artist ever been catalogued? Asked separately from the windowed read because a
    // catalogued artist with a quiet month and an artist nobody has ever crawled produce the
    // same empty result set, and only the second one should trigger a live scrape.
    const { count: catalogued, error: countError } = await client
      .from('releases')
      .select('id', { count: 'exact', head: true })
      .eq('artist_id', id);

    if (countError) {
      console.error('[DB] getReleasesForAlerts count failed:', countError.message);
      return null;
    }
    if (!catalogued) return null;

    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);

    const { data, error } = await client
      .from('releases')
      .select(
        'slug, title, release_date, date_precision, status, artwork_url,' +
        ' release_sources ( platform, url, release_offers ( price, currency, availability ) )'
      )
      .eq('artist_id', id)
      .eq('is_hidden', false)
      // A tier-3 fuzzy flag means we are not sure this is a distinct record. Sending a push
      // notification about it would publish that uncertainty to a fan's lock screen, so flagged
      // rows wait for the review queue rather than alerting.
      .eq('needs_review', false)
      .gte('release_date', since)
      .order('release_date', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[DB] getReleasesForAlerts read failed:', error.message);
      return null;
    }

    type Row = {
      slug: string;
      title: string;
      release_date: string | null;
      date_precision: string | null;
      status: string;
      artwork_url: string | null;
      release_sources: {
        platform: string;
        url: string;
        release_offers: { price: number | null; currency: string | null; availability: string }[] | null;
      }[] | null;
    };

    const releases = ((data as unknown as Row[]) || []).map(r => ({
      slug: r.slug,
      title: r.title,
      releaseDate: r.release_date,
      datePrecision: r.date_precision,
      status: r.status,
      artworkUrl: r.artwork_url,
      sources: (r.release_sources || []).map(s => ({
        platform: s.platform,
        url: s.url,
        offers: s.release_offers || [],
      })),
    }));

    return { artistSlug: slug, releases };
  } catch (error) {
    console.error('[DB] getReleasesForAlerts error:', error);
    return null;
  }
}
