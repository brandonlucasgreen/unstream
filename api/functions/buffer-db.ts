// The stored Buffer connection, and the one safe way to get a usable access token from it
// (docs/specs/curator-posts-spec.md, "Buffer auth").
//
// Kept out of db.ts, which is already large, the way tips-db.ts is. Everything here goes through
// the service-role client: buffer_connections has RLS on with no policies, so nothing else can
// read it.

import { getClient } from './db';
import { decryptCredential, encryptCredential, isCredentialKeyConfigured } from './credential-crypto';
import { BufferError } from './buffer-client';
import { needsRefresh, refreshTokens, type BufferTokens } from './buffer-oauth';
import { getFeatureFlag } from './feature-flags';
import { Sentry } from '../lib/sentry';

/**
 * Whether this signed-in account may use curator posts: everyone once `curatorPosts` is on, and
 * the admin account (ADMIN_EMAIL) always, so the feature can be tested end to end before it is
 * switched on — the tips precedent (`canSetUpTips`). The flag still fails closed for everyone
 * else.
 */
export async function canUseCuratorPosts(email: string): Promise<boolean> {
  const admin = process.env.ADMIN_EMAIL;
  if (admin && email.toLowerCase() === admin.toLowerCase()) return true;
  return getFeatureFlag('curatorPosts');
}

export interface BufferConnection {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  organizationId: string | null;
  selectedChannelIds: string[];
  refreshCounter: number;
  /** When a request claimed a refresh it hasn't finished, or null when none is under way. */
  refreshClaimedAt: Date | null;
}

interface ConnectionRow {
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: string;
  organization_id: string | null;
  selected_channel_ids: string[] | null;
  refresh_counter: number;
  refresh_claimed_at: string | null;
}

function toConnection(row: ConnectionRow): BufferConnection {
  return {
    accessToken: decryptCredential(row.access_token_encrypted),
    refreshToken: row.refresh_token_encrypted ? decryptCredential(row.refresh_token_encrypted) : null,
    expiresAt: new Date(row.expires_at),
    organizationId: row.organization_id,
    selectedChannelIds: row.selected_channel_ids ?? [],
    refreshCounter: Number(row.refresh_counter),
    refreshClaimedAt: row.refresh_claimed_at ? new Date(row.refresh_claimed_at) : null,
  };
}

/** The curator's connection, or null when they haven't connected one. */
export async function getBufferConnection(userId: string): Promise<BufferConnection | null> {
  const client = getClient();
  if (!client || !isCredentialKeyConfigured()) return null;

  const { data, error } = await client
    .from('buffer_connections')
    .select('access_token_encrypted, refresh_token_encrypted, expires_at, organization_id, selected_channel_ids, refresh_counter, refresh_claimed_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? toConnection(data as ConnectionRow) : null;
}

/** Store a fresh grant, replacing any connection the curator already had. */
export async function saveBufferConnection(userId: string, tokens: BufferTokens, organizationId: string | null): Promise<void> {
  const client = getClient();
  if (!client) throw new BufferError(500, 'Database not configured');
  if (!isCredentialKeyConfigured()) throw new BufferError(500, 'Credential encryption is not configured');

  const { error } = await client.from('buffer_connections').upsert({
    user_id: userId,
    access_token_encrypted: encryptCredential(tokens.accessToken),
    refresh_token_encrypted: tokens.refreshToken ? encryptCredential(tokens.refreshToken) : null,
    expires_at: tokens.expiresAt.toISOString(),
    organization_id: organizationId,
    // A reconnect starts the counter again; it only ever guards concurrent refreshes of one grant.
    refresh_counter: 0,
    refresh_claimed_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  if (error) throw new Error(error.message);
}

/** Forget the connection — on disconnect, and whenever Buffer tells us the grant is dead. */
export async function clearBufferConnection(userId: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  const { error } = await client.from('buffer_connections').delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/**
 * Switch the connection to another of the curator's Buffer organizations.
 *
 * The ticked channels belong to the old organization, so they go with it: a channel id from one
 * organization means nothing in another, and keeping it would leave a selection nobody can see.
 */
export async function setOrganization(userId: string, organizationId: string): Promise<void> {
  const client = getClient();
  if (!client) throw new BufferError(500, 'Database not configured');
  const { error } = await client
    .from('buffer_connections')
    .update({ organization_id: organizationId, selected_channel_ids: [], updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

export async function setSelectedChannels(userId: string, channelIds: string[]): Promise<void> {
  const client = getClient();
  if (!client) throw new BufferError(500, 'Database not configured');
  const { error } = await client
    .from('buffer_connections')
    .update({ selected_channel_ids: channelIds, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/** Raised when the curator has to reconnect: no connection, or Buffer rejected the grant. */
export class BufferNotConnectedError extends Error {
  constructor(message = 'Buffer is not connected') {
    super(message);
    this.name = 'BufferNotConnectedError';
  }
}

/** How long a request waits for another one's refresh to land before giving up for now. */
const REFRESH_WAIT_MS = 8_000;
const REFRESH_POLL_MS = 250;

/**
 * How long a claimed refresh holds off everyone else. Longer than any refresh can take inside one
 * function (Buffer's 15-second timeout, a function's ten), so only a claim whose request has died
 * runs out; after that, the next request may claim again.
 */
const REFRESH_LEASE_MS = 30_000;

/**
 * A usable access token for this user, refreshing first if the stored one is spent.
 *
 * **This is the only way anything should read a token.** Buffer's access tokens last an hour, so
 * a stored one is usually stale, and its refresh tokens are single-use: **"Reusing an old refresh
 * token revokes all tokens for that grant"** (Buffer's authentication guide). Two requests that
 * both send the same refresh token don't just race; the second one makes Buffer cancel the
 * connection, and the user has to reconnect.
 *
 * So the refresh is **claimed in the database before Buffer is called**: a compare-and-set that
 * bumps `refresh_counter` and stamps `refresh_claimed_at`. Only the request that wins the claim
 * ever sends the refresh token. Anyone else waits for the winner's new token to land, and never
 * calls Buffer itself: one that read the row before the claim loses the compare-and-set, and one
 * that reads it after sees the claim's stamp.
 *
 * Until 2026-10-29 the compare-and-set came after the call to Buffer, so both requests had
 * already spent the token by the time one lost. A page that loaded its data twice on a hard
 * refresh (the browser's own sign-in token refreshing at the same moment) did exactly that, and
 * the Promote page asked Brandon to reconnect after every deploy.
 *
 * Until 2026-10-30 the claim was the counter alone, which only stops requests that read the row
 * before it moved. One that read it during the winner's call to Buffer saw the new counter and
 * the still-stale token, won a claim of its own, and sent the old refresh token again. A deploy
 * made that likely: a tab reloading itself onto the new build while another request was in
 * flight, and a cold function taking seconds over the refresh. The stamp closes it.
 */
export async function usableAccessToken(userId: string): Promise<string> {
  const connection = await getBufferConnection(userId);
  if (!connection) throw new BufferNotConnectedError();
  if (!needsRefresh(connection.expiresAt)) return connection.accessToken;

  if (!connection.refreshToken) {
    // No refresh token means offline_access was never granted; nothing can revive this.
    reportLostConnection(userId, 'no refresh token stored');
    await clearBufferConnection(userId);
    throw new BufferNotConnectedError('That Buffer connection expired and cannot be refreshed. Reconnect to continue.');
  }

  // Someone else's refresh is under way: their new token is coming.
  if (connection.refreshClaimedAt && Date.now() - connection.refreshClaimedAt.getTime() < REFRESH_LEASE_MS) {
    return waitForRefresh(userId);
  }

  const client = getClient();
  if (!client) throw new BufferError(500, 'Database not configured');

  // The claim. Whoever moves the counter on owns this refresh; anyone else waits for it.
  const claim = connection.refreshCounter + 1;
  const { data: claimed, error: claimError } = await client
    .from('buffer_connections')
    .update({ refresh_counter: claim, refresh_claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('refresh_counter', connection.refreshCounter)
    .select('refresh_counter');
  if (claimError) throw new Error(claimError.message);
  if (!claimed || claimed.length === 0) return waitForRefresh(userId);

  let tokens: BufferTokens;
  try {
    tokens = await refreshTokens(connection.refreshToken);
  } catch (error) {
    // invalid_grant: already spent, or revoked by the user in Buffer's settings. Either way the
    // grant is gone, so clear it and ask them to reconnect rather than looping. Reported, so a
    // connection that keeps dying is seen instead of looking like a user who never connected.
    if (error instanceof BufferError && (error.status === 400 || error.status === 401)) {
      reportLostConnection(userId, `refresh refused (HTTP ${error.status}): ${error.message}`);
      await clearBufferConnection(userId);
      throw new BufferNotConnectedError('Buffer refused the connection. Reconnect to continue.');
    }
    // Anything else (a timeout, a 5xx) may or may not have reached Buffer. Release the claim so
    // the next request can try again rather than wait out the lease.
    await client
      .from('buffer_connections')
      .update({ refresh_claimed_at: null })
      .eq('user_id', userId)
      .eq('refresh_counter', claim)
      .select('refresh_counter');
    throw error;
  }

  if (!tokens.refreshToken) {
    // Buffer says every refresh returns a new one. When it doesn't, the one we sent is kept
    // rather than overwritten with nothing: nothing guarantees the connection dies at the next
    // expiry, an hour later, while the old token may well still work. Reported either way.
    Sentry.captureMessage('[buffer] a refresh returned no new refresh token', {
      level: 'error',
      tags: { buffer: 'refresh-without-token' },
    });
  }

  const { data, error } = await client
    .from('buffer_connections')
    .update({
      access_token_encrypted: encryptCredential(tokens.accessToken),
      refresh_token_encrypted: encryptCredential(tokens.refreshToken ?? connection.refreshToken),
      expires_at: tokens.expiresAt.toISOString(),
      refresh_claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('refresh_counter', claim)
    .select('access_token_encrypted');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    // The row changed under our claim: the user reconnected (which resets the counter) or
    // disconnected while we refreshed. Their current connection stands; this token is good for now.
    Sentry.captureMessage('[buffer] connection changed during a refresh', { level: 'info', tags: { buffer: 'refresh-superseded' } });
  }
  return tokens.accessToken;
}

/**
 * Another request holds the refresh: wait for its new token instead of sending the refresh token
 * a second time. If it doesn't land in time, fail this request only. The connection is untouched,
 * and the next request tries again.
 */
async function waitForRefresh(userId: string): Promise<string> {
  const deadline = Date.now() + REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, REFRESH_POLL_MS));
    const current = await getBufferConnection(userId);
    if (!current) throw new BufferNotConnectedError();
    if (!needsRefresh(current.expiresAt)) return current.accessToken;
  }
  throw new BufferError(503, 'Buffer is reconnecting. Try again in a moment.');
}

/** A connection is about to be dropped and the user asked to reconnect: never silently. */
function reportLostConnection(userId: string, reason: string): void {
  Sentry.captureMessage('[buffer] connection dropped; the user has to reconnect', {
    level: 'warning',
    tags: { buffer: 'connection-dropped' },
    extra: { userId, reason },
  });
}
