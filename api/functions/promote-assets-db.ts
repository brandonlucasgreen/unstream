// Promote's asset library: the images an artist uploads for their posts
// (docs/specs/release-autopost-spec.md, "Pictures, and Instagram"). Server-only table, read and
// written here after the feature gate and the verified-claim check.
//
// **Removing an upload is real, but not instant when a post still needs it.** Buffer fetches a
// post's image on the day it publishes, and posts go to Buffer three days ahead. So removing an
// upload hides it at once, and the file goes when no post already in Buffer is waiting for it:
// straight away when none is, otherwise on a later sweep (purgeRemovedAssets).

import { getClient } from './db';
import { deleteStoredObject, type MediaBucket } from './autopost-media';

/** The library's size per artist (spec: "Up to 12 images per artist profile"). */
export const MAX_ASSETS = 12;

/** A post in Buffer may still fetch its image until this long after its time. */
const STILL_NEEDED_MS = 24 * 3_600_000;

function client() {
  const c = getClient();
  if (!c) throw new Error('Database not configured');
  return c;
}

export interface PromoteAsset {
  id: string;
  url: string;
  storageKey: string;
  width: number;
  height: number;
  createdAt: string;
}

interface AssetRow {
  id: string;
  url: string;
  storage_key: string;
  width: number;
  height: number;
  created_at: string;
}

const toAsset = (r: AssetRow): PromoteAsset => ({
  id: r.id, url: r.url, storageKey: r.storage_key, width: r.width, height: r.height, createdAt: r.created_at,
});

/** An artist's library, oldest first: the order autopost takes them in. Throws on a failed read. */
export async function listAssets(artistId: string): Promise<PromoteAsset[]> {
  const { data, error } = await client()
    .from('promote_assets')
    .select('id, url, storage_key, width, height, created_at')
    .eq('artist_id', artistId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(MAX_ASSETS * 2);
  if (error) throw new Error(`promote_assets read failed: ${error.message}`);
  return (data as AssetRow[]).map(toAsset);
}

/**
 * Record an upload. The same file uploaded twice is one object and one row: the existing row is
 * returned rather than a second made.
 */
export async function addAsset(input: {
  artistId: string;
  userId: string;
  storageKey: string;
  url: string;
  contentType: string;
  width: number;
  height: number;
  byteSize: number;
}): Promise<PromoteAsset> {
  const existing = (await listAssets(input.artistId)).find(a => a.storageKey === input.storageKey);
  if (existing) return existing;
  const { data, error } = await client()
    .from('promote_assets')
    .insert({
      artist_id: input.artistId,
      user_id: input.userId,
      storage_key: input.storageKey,
      url: input.url,
      content_type: input.contentType,
      width: input.width,
      height: input.height,
      byte_size: input.byteSize,
    })
    .select('id, url, storage_key, width, height, created_at')
    .single();
  if (error) throw new Error(`saving an upload failed: ${error.message}`);
  return toAsset(data as AssetRow);
}

/** Whether a post already handed to Buffer (or being handed) may still fetch this upload. */
async function stillNeeded(assetId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - STILL_NEEDED_MS).toISOString();
  const key = `upload:${assetId}`;
  const [autopost, campaign] = await Promise.all([
    client().from('release_autopost_posts').select('id').eq('image_key', key)
      .in('status', ['pushing', 'pushed']).gte('slot_at', since).limit(1),
    client().from('release_campaign_posts').select('id').eq('image_key', key)
      .in('status', ['pushing', 'pushed']).gte('slot_at', since).limit(1),
  ]);
  if (autopost.error) throw new Error(`release_autopost_posts read failed: ${autopost.error.message}`);
  if (campaign.error) throw new Error(`release_campaign_posts read failed: ${campaign.error.message}`);
  return (autopost.data?.length ?? 0) > 0 || (campaign.data?.length ?? 0) > 0;
}

/** Whether another live row (the same file uploaded again after removing it) shares the object. */
async function keyInUse(artistId: string, storageKey: string): Promise<boolean> {
  const { data, error } = await client()
    .from('promote_assets').select('id')
    .eq('artist_id', artistId).eq('storage_key', storageKey).is('deleted_at', null).limit(1);
  if (error) throw new Error(`promote_assets read failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

async function deleteNow(bucket: MediaBucket, row: { id: string; artist_id: string; storage_key: string }): Promise<void> {
  if (!(await keyInUse(row.artist_id, row.storage_key))) await deleteStoredObject(bucket, row.storage_key);
  const { error } = await client().from('promote_assets').delete().eq('id', row.id);
  if (error) throw new Error(`deleting an upload failed: ${error.message}`);
}

/**
 * Remove an upload from an artist's library. Campaign posts not yet sent that used it lose their
 * image (the editor then flags them). Returns false when the artist has no such upload.
 */
export async function removeAsset(bucket: MediaBucket, artistId: string, assetId: string, now: Date): Promise<boolean> {
  const { data, error } = await client()
    .from('promote_assets')
    .update({ deleted_at: now.toISOString() })
    .eq('id', assetId).eq('artist_id', artistId).is('deleted_at', null)
    .select('id, artist_id, storage_key');
  if (error) throw new Error(`removing an upload failed: ${error.message}`);
  const row = (data as { id: string; artist_id: string; storage_key: string }[])[0];
  if (!row) return false;

  const unset = await client()
    .from('release_campaign_posts')
    .update({ image_key: null, updated_at: now.toISOString() })
    .eq('artist_id', artistId).eq('image_key', `upload:${assetId}`).in('status', ['planned', 'failed']);
  if (unset.error) throw new Error(`clearing an upload from campaign posts failed: ${unset.error.message}`);

  if (!(await stillNeeded(assetId, now))) await deleteNow(bucket, row);
  return true;
}

/** Delete the files of removed uploads that no post in Buffer needs any more. Run by the sweep. */
export async function purgeRemovedAssets(bucket: MediaBucket, now: Date): Promise<number> {
  const { data, error } = await client()
    .from('promote_assets').select('id, artist_id, storage_key')
    .not('deleted_at', 'is', null).limit(50);
  if (error) throw new Error(`promote_assets read failed: ${error.message}`);
  let purged = 0;
  for (const row of data as { id: string; artist_id: string; storage_key: string }[]) {
    if (await stillNeeded(row.id, now)) continue;
    await deleteNow(bucket, row);
    purged++;
  }
  return purged;
}
