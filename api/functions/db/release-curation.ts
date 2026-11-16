// What a verified artist does to their own releases: order, hide, edit, add a link, create one.

import { deriveStatus, mapReleaseType, parseReleaseDate, releaseMatchKey, uniqueReleaseSlug } from '../release-utils';
import { getClient } from './client';

// --- Artist release curation (spec §11) ---
//
// The artist-facing half of the dedup backstop, and the durable fix for whatever the ~4%
// wrong-artist probe rate and under-merge bias leave behind: a verified artist reviewing their
// own catalog is the one source of ground truth ingest can never have. Every write here goes
// through the same "service role + server-side ownership check" convention as
// `api/functions/artist-profile.ts` — there is no RLS policy keyed to auth.uid() for these
// tables (see the comment on `releases` in the schema migration), so the ownership check below
// *is* the security boundary, not a UI nicety.

export interface OwnedArtistCheck {
  ok: boolean;
  status: number;
  error?: string;
  artistId?: string;
  artistName?: string;
}

/**
 * Resolve a slug to an artist and verify the given user owns a verified claim on it. The same
 * check `artist-profile.ts` inlines for bio/link edits, factored out here so newer
 * release-curation endpoints don't each carry their own copy of an auth-critical block.
 */
export async function resolveOwnedArtist(slug: string, userId: string): Promise<OwnedArtistCheck> {
  const client = getClient();
  if (!client) return { ok: false, status: 500, error: 'Database not configured' };

  const { data: artist, error: findError } = await client
    .from('artists')
    .select('id, name')
    .eq('slug', slug)
    .single();

  if (findError || !artist) return { ok: false, status: 404, error: 'Artist not found' };

  const { data: profile, error: profileError } = await client
    .from('artist_profiles')
    .select('user_id, verified_at')
    .eq('artist_id', artist.id)
    .single();

  if (profileError || !profile) return { ok: false, status: 404, error: 'Profile not found' };
  if (profile.user_id !== userId) return { ok: false, status: 403, error: 'You do not own this profile' };
  if (!profile.verified_at) return { ok: false, status: 403, error: 'Profile not yet verified' };

  return { ok: true, status: 200, artistId: (artist as { id: string }).id, artistName: (artist as { name: string }).name };
}

/**
 * Do all of these release ids actually belong to this artist? `resolveOwnedArtist` proves the
 * caller owns *an* artist profile — it says nothing about whether the release ids they sent in
 * the request body are that artist's. Every action that takes a release id from the client
 * must check this before touching the row, or a claimed artist could hide/merge/edit another
 * artist's releases by guessing UUIDs.
 */
export async function verifyReleaseOwnership(artistId: string, releaseIds: string[]): Promise<boolean> {
  const client = getClient();
  if (!client || releaseIds.length === 0) return false;

  const unique = [...new Set(releaseIds)];
  const { data, error } = await client
    .from('releases')
    .select('id')
    .eq('artist_id', artistId)
    .in('id', unique);

  if (error) {
    console.error('[DB] verifyReleaseOwnership failed:', error.message);
    return false;
  }
  return (data || []).length === unique.length;
}

export interface OwnerReleaseItem {
  id: string;
  title: string;
  slug: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string | null;
  artworkUrl: string | null;
  isHidden: boolean;
  needsReview: boolean;
  flaggedAgainst: { id: string; title: string } | null;
  /** Position in the artist's manual order, or null if they haven't arranged this one. */
  displayOrder: number | null;
  sources: { platform: string; url: string }[];
}

/**
 * Every release under this artist — including hidden ones and needs_review ones, unlike the
 * public `getArtistReleases`, because the whole point of this view is letting the artist see
 * what ingest did (right or wrong) rather than only what a fan would see.
 *
 * Ordered exactly as the public page orders them, so what the artist arranges here is what a
 * fan sees rather than a second arrangement that only exists in the editor.
 */
export async function getArtistReleasesForOwner(artistId: string): Promise<OwnerReleaseItem[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('releases')
      .select(
        'id, title, slug, release_type, release_date, date_precision, artwork_url, is_hidden,' +
        ' needs_review, flagged_against_release_id, display_order, release_sources ( platform, url )'
      )
      .eq('artist_id', artistId)
      .order('display_order', { ascending: true, nullsFirst: false })
      .order('release_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[DB] getArtistReleasesForOwner failed:', error.message);
      return [];
    }

    type Row = {
      id: string;
      title: string;
      slug: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      is_hidden: boolean;
      needs_review: boolean;
      flagged_against_release_id: string | null;
      display_order: number | null;
      release_sources: { platform: string; url: string }[] | null;
    };

    const rows = (data as unknown as Row[]) || [];
    // The counterpart a release is flagged against is always another row in this same result
    // set — tier-3 fuzzy matching only ever compares releases under one artist — so resolving
    // its title costs nothing extra to fetch.
    const titleById = new Map(rows.map(r => [r.id, r.title]));

    return rows.map(r => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      releaseType: r.release_type,
      releaseDate: r.release_date,
      datePrecision: r.date_precision,
      artworkUrl: r.artwork_url,
      isHidden: r.is_hidden,
      needsReview: r.needs_review,
      flaggedAgainst:
        r.flagged_against_release_id && titleById.has(r.flagged_against_release_id)
          ? { id: r.flagged_against_release_id, title: titleById.get(r.flagged_against_release_id)! }
          : null,
      displayOrder: r.display_order,
      sources: (r.release_sources || []).map(s => ({ platform: s.platform, url: s.url })),
    }));
  } catch (error) {
    console.error('[DB] getArtistReleasesForOwner error:', error);
    return [];
  }
}

/**
 * Store a claimed artist's manual release order.
 *
 * `releaseIds` is the complete arrangement the editor is showing, in display order. Releases
 * left out of it are reset to unpositioned, so an empty array is "back to newest first", and a
 * release catalogued between the page loading and saving isn't handed a position nobody chose —
 * it stays null and sorts to the end.
 *
 * One RPC because it's one transaction: a half-written order is an arrangement the artist never
 * picked, showing on their public page. Same reasoning as `replace_artist_links`.
 */
export async function setReleaseDisplayOrder(artistId: string, releaseIds: string[]): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  const { error } = await client.rpc('set_release_display_order', {
    p_artist_id: artistId,
    p_release_ids: releaseIds,
  });

  if (error) {
    console.error('[DB] setReleaseDisplayOrder failed:', error.message);
    return false;
  }
  return true;
}

/** "This shouldn't be on my page." Ingest must never write `is_hidden` — only this, or an admin. */
export async function setReleaseHidden(artistId: string, releaseId: string, hidden: boolean): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  if (!(await verifyReleaseOwnership(artistId, [releaseId]))) return false;

  const { error } = await client.from('releases').update({ is_hidden: hidden }).eq('id', releaseId);
  if (error) {
    console.error('[DB] setReleaseHidden failed:', error.message);
    return false;
  }
  return true;
}

export interface ReleaseFieldPatch {
  title?: string;
  /** null clears the date entirely; omit the key to leave it untouched. */
  releaseDate?: string | null;
  artworkUrl?: string | null;
}

/**
 * "Fix" — correct a title, date, or artwork ingest got wrong. Every field touched here is
 * added to `curated_fields`, the existing provenance mechanism that stops a later re-crawl from
 * silently reverting the artist's correction (see the `releases` migration's own comment on
 * why this had to ship in step 1, not be retrofitted later).
 */
export async function updateArtistReleaseFields(
  artistId: string,
  releaseId: string,
  patch: ReleaseFieldPatch
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  if (!(await verifyReleaseOwnership(artistId, [releaseId]))) return false;

  const { data: row, error: readError } = await client
    .from('releases')
    .select('curated_fields')
    .eq('id', releaseId)
    .maybeSingle();

  if (readError || !row) {
    console.error('[DB] updateArtistReleaseFields read failed:', readError?.message ?? 'not found');
    return false;
  }

  const curated = new Set((row as { curated_fields: string[] | null }).curated_fields ?? []);
  const update: Record<string, unknown> = {};

  if (patch.title !== undefined) {
    const title = patch.title.trim().slice(0, 200);
    if (!title) return false;
    update.title = title;
    curated.add('title');
  }
  if (patch.releaseDate !== undefined) {
    if (patch.releaseDate === null) {
      update.release_date = null;
      update.date_precision = 'unknown';
    } else {
      const { date, precision } = parseReleaseDate(patch.releaseDate);
      if (!date) return false;
      update.release_date = date;
      update.date_precision = precision;
    }
    curated.add('release_date');
  }
  if (patch.artworkUrl !== undefined) {
    update.artwork_url = patch.artworkUrl;
    curated.add('artwork_url');
  }

  if (Object.keys(update).length === 0) return true;
  update.curated_fields = [...curated];

  const { error } = await client.from('releases').update(update).eq('id', releaseId);
  if (error) {
    console.error('[DB] updateArtistReleaseFields update failed:', error.message);
    return false;
  }
  return true;
}

/**
 * "Add a platform link we missed" — or correct one ingest got wrong. Written with
 * `source: 'claimed'`, which `getExistingSources` (used by every ingest path) checks before
 * ever overwriting a source's URL — the same "never clobber a curated edit" rule `curated_fields`
 * enforces on the release row itself, one table over.
 */
export async function addArtistReleaseLink(
  artistId: string,
  releaseId: string,
  platform: string,
  url: string
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  if (!(await verifyReleaseOwnership(artistId, [releaseId]))) return false;

  // `external_id` is never written here, in either branch. It is the one thing that makes a
  // re-crawl idempotent, so an artist correcting a URL must leave whatever id ingest stored
  // exactly as it is — writing an explicit null would have the next crawl mint a duplicate
  // source rather than update this row.
  const { data: existingRows, error: readError } = await client
    .from('release_sources')
    .select('id, source')
    .eq('release_id', releaseId)
    .eq('platform', platform);

  if (readError) {
    console.error('[DB] addArtistReleaseLink read failed:', readError.message);
    return false;
  }

  const rows = (existingRows as { id: string; source: string }[] | null) || [];
  const claimedRow = rows.find((row) => row.source === 'claimed');

  // A release can now hold several sources on one platform (two Discogs masters an admin
  // merged into one record). If the artist already has their own claimed row, that's
  // unambiguous — it's theirs, so update it regardless of how many ingest sources sit beside
  // it. Otherwise, with 2+ ingest sources and no claimed row, "set this platform's link" has
  // no single answer, and picking one at random would silently rewrite a URL the artist never
  // looked at.
  if (!claimedRow && rows.length > 1) {
    console.error('[DB] addArtistReleaseLink: release has multiple', platform, 'sources; refusing to guess');
    return false;
  }

  const targetId = claimedRow?.id ?? (rows.length === 1 ? rows[0].id : undefined);

  const write = targetId
    ? client.from('release_sources').update({ url, source: 'claimed', last_seen_at: new Date().toISOString() }).eq('id', targetId)
    : client.from('release_sources').insert({ release_id: releaseId, platform, url, source: 'claimed', last_seen_at: new Date().toISOString() });

  const { error } = await write;

  if (error) {
    // The read above is not atomic with the write: two concurrent calls can both see zero rows
    // and both insert. `idx_release_sources_release_platform_external` — which two id-less rows
    // on one platform can never both satisfy — is what actually catches that, as a 23505 on the
    // insert we lost the race on. Whoever won gets treated as "already there"; fall back to
    // updating their row instead of failing the request.
    if (rows.length === 0 && error.code === '23505') {
      const { data: retryRows, error: retryError } = await client
        .from('release_sources')
        .select('id')
        .eq('release_id', releaseId)
        .eq('platform', platform)
        .is('external_id', null);

      if (retryError || (retryRows as { id: string }[] | null || []).length !== 1) {
        console.error('[DB] addArtistReleaseLink: conflict retry did not resolve to one row', retryError?.message);
        return false;
      }

      const { error: updateError } = await client
        .from('release_sources')
        .update({ url, source: 'claimed', last_seen_at: new Date().toISOString() })
        .eq('id', (retryRows as { id: string }[])[0].id);

      if (updateError) {
        console.error('[DB] addArtistReleaseLink conflict-retry update failed:', updateError.message);
        return false;
      }
      return true;
    }

    console.error('[DB] addArtistReleaseLink failed:', error.message);
    return false;
  }
  return true;
}

export interface NewArtistRelease {
  title: string;
  releaseType: string;
  releaseDate: string | null;
  platform: string;
  url: string;
}

export interface CreateReleaseResult {
  ok: boolean;
  error?: string;
  releaseId?: string;
}

/**
 * "Add a release we never found." A release row ingest has no idea exists, so unlike
 * everything else in this file it is never matched against `existing` — it's simply created,
 * fully curated from the start (ingest must never touch a hand-authored row).
 */
export async function createArtistRelease(artistId: string, input: NewArtistRelease): Promise<CreateReleaseResult> {
  const client = getClient();
  if (!client) return { ok: false, error: 'Database not configured' };

  const title = input.title.trim().slice(0, 200);
  if (!title) return { ok: false, error: 'Title is required' };

  const matchKey = releaseMatchKey(title);
  if (!matchKey) return { ok: false, error: 'Title needs at least one letter or number' };

  const releaseType = mapReleaseType(input.releaseType);
  const now = new Date();
  const { date, precision } = input.releaseDate
    ? parseReleaseDate(input.releaseDate, now)
    : { date: null, precision: 'unknown' as const };

  try {
    const { data: existingSlugs, error: slugError } = await client
      .from('releases')
      .select('slug')
      .eq('artist_id', artistId);

    if (slugError) {
      console.error('[DB] createArtistRelease slug read failed:', slugError.message);
      return { ok: false, error: 'Failed to create release' };
    }

    const taken = new Set(((existingSlugs as { slug: string }[] | null) || []).map(r => r.slug));
    const slug = uniqueReleaseSlug(title, taken);

    const { data: inserted, error } = await client
      .from('releases')
      .insert({
        artist_id: artistId,
        title,
        slug,
        match_key: matchKey,
        release_type: releaseType,
        release_date: date,
        date_precision: precision,
        status: deriveStatus(date, false, now),
        source: 'claimed',
        curated_fields: ['title', 'release_date'],
      })
      .select('id')
      .single();

    if (error || !inserted) {
      console.error('[DB] createArtistRelease insert failed:', error?.message);
      return { ok: false, error: 'Failed to create release' };
    }

    const releaseId = (inserted as { id: string }).id;

    const { error: sourceError } = await client.from('release_sources').insert({
      release_id: releaseId,
      platform: input.platform,
      url: input.url,
      external_id: null,
      source: 'claimed',
    });

    if (sourceError) {
      console.error('[DB] createArtistRelease source insert failed:', sourceError.message);
      // The release itself was created — better to hand back a release missing its one link
      // than to lose the title/date/type the artist just entered.
      return { ok: true, releaseId };
    }

    return { ok: true, releaseId };
  } catch (error) {
    console.error('[DB] createArtistRelease error:', error);
    return { ok: false, error: 'Unexpected error' };
  }
}
