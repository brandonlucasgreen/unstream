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
}

interface ConnectionRow {
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: string;
  organization_id: string | null;
  selected_channel_ids: string[] | null;
  refresh_counter: number;
}

function toConnection(row: ConnectionRow): BufferConnection {
  return {
    accessToken: decryptCredential(row.access_token_encrypted),
    refreshToken: row.refresh_token_encrypted ? decryptCredential(row.refresh_token_encrypted) : null,
    expiresAt: new Date(row.expires_at),
    organizationId: row.organization_id,
    selectedChannelIds: row.selected_channel_ids ?? [],
    refreshCounter: Number(row.refresh_counter),
  };
}

/** The curator's connection, or null when they haven't connected one. */
export async function getBufferConnection(userId: string): Promise<BufferConnection | null> {
  const client = getClient();
  if (!client || !isCredentialKeyConfigured()) return null;

  const { data, error } = await client
    .from('buffer_connections')
    .select('access_token_encrypted, refresh_token_encrypted, expires_at, organization_id, selected_channel_ids, refresh_counter')
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

/**
 * A usable access token for this curator, refreshing first if the stored one is spent.
 *
 * **This is the only way anything should read a token.** Buffer's access tokens last an hour,
 * so a stored one is usually stale, and its refresh tokens are single-use — replaying one
 * revokes the entire grant and silently disconnects the curator.
 *
 * So the refresh is a compare-and-set on `refresh_counter`: the caller spends the token it read,
 * and writes back only if nobody else has refreshed since. The loser of a race affects no rows,
 * and **re-reads instead of calling Buffer**, because its own refresh token is now spent. It
 * never retries the refresh.
 */
export async function usableAccessToken(userId: string): Promise<string> {
  const connection = await getBufferConnection(userId);
  if (!connection) throw new BufferNotConnectedError();
  if (!needsRefresh(connection.expiresAt)) return connection.accessToken;

  if (!connection.refreshToken) {
    // No refresh token means offline_access was never granted; nothing can revive this.
    await clearBufferConnection(userId);
    throw new BufferNotConnectedError('That Buffer connection expired and cannot be refreshed. Reconnect to continue.');
  }

  let tokens: BufferTokens;
  try {
    tokens = await refreshTokens(connection.refreshToken);
  } catch (error) {
    // invalid_grant: already spent, or the curator revoked us in Buffer's settings. Either way
    // the grant is gone — clear it so the page asks them to reconnect rather than looping.
    if (error instanceof BufferError && (error.status === 400 || error.status === 401)) {
      await clearBufferConnection(userId);
      throw new BufferNotConnectedError('Buffer refused the connection. Reconnect to continue.');
    }
    throw error;
  }

  const client = getClient();
  if (!client) throw new BufferError(500, 'Database not configured');

  const { data, error } = await client
    .from('buffer_connections')
    .update({
      access_token_encrypted: encryptCredential(tokens.accessToken),
      refresh_token_encrypted: tokens.refreshToken ? encryptCredential(tokens.refreshToken) : null,
      expires_at: tokens.expiresAt.toISOString(),
      refresh_counter: connection.refreshCounter + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('refresh_counter', connection.refreshCounter)
    .select('access_token_encrypted');

  if (error) throw new Error(error.message);

  if (!data || data.length === 0) {
    // Someone else refreshed between our read and our write. Their tokens are the live ones and
    // ours are already retired, so take theirs rather than refreshing again.
    const winner = await getBufferConnection(userId);
    if (!winner) throw new BufferNotConnectedError();
    Sentry.captureMessage('[buffer] concurrent refresh; used the winning token', {
      level: 'info',
      tags: { buffer: 'refresh-race' },
    });
    return winner.accessToken;
  }

  return tokens.accessToken;
}
