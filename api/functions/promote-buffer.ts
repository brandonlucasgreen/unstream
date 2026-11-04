// The Buffer side of the Promote page, shared by the Autopost tab (artist-promote.ts) and the
// Campaigns tab (artist-campaigns.ts). Both tabs connect Buffer, choose the organization and tick
// channels, so both ask Buffer the same two questions (docs/specs/release-autopost-spec.md,
// "Release campaigns": the connection and the organization are shared, the channels are not).

import { BufferNotConnectedError, usableAccessToken } from './buffer-db';
import { listChannels, listOrganizations } from './buffer-client';
import { isAutopostNetwork } from './autopost-channel-post';

export interface PromoteChannel {
  id: string;
  name: string;
  service: string;
  /** Whether Unstream writes posts for this network at all. */
  supported: boolean;
}

export type BufferState =
  | { connected: false }
  | { connected: true; organizations: { id: string; name: string }[]; organizationId: string | null; channels: PromoteChannel[] };

/**
 * A usable Buffer token, or null when the account isn't connected. Read once per request and
 * shared: two reads at once could both refresh it, and Buffer revokes a connection whose refresh
 * token is spent twice (usableAccessToken in buffer-db.ts).
 */
export async function bufferToken(userId: string): Promise<string | null> {
  try {
    return await usableAccessToken(userId);
  } catch (error) {
    if (error instanceof BufferNotConnectedError) return null;
    throw error;
  }
}

/** Their Buffer organizations, and the chosen one's channels. */
export async function bufferState(token: string | null, organizationId: string | null): Promise<BufferState> {
  if (!token) return { connected: false };
  try {
    const organizations = await listOrganizations(token);
    // Nothing to choose with a single organization, so it's offered already chosen.
    const orgId = organizations.some(o => o.id === organizationId)
      ? organizationId
      : organizations.length === 1 ? organizations[0].id : null;
    const channels = orgId ? (await listChannels(token, orgId)).filter(c => !c.isDisconnected) : [];
    return {
      connected: true,
      organizations,
      organizationId: orgId,
      channels: channels.map(c => ({ id: c.id, name: c.name, service: c.service, supported: isAutopostNetwork(c.service) })),
    };
  } catch (error) {
    if (error instanceof BufferNotConnectedError) return { connected: false };
    throw error;
  }
}

/** The channels of `wanted` that Buffer still has, connected, on a network Unstream writes for. */
export function usableChannels(state: BufferState, wanted: string[]): PromoteChannel[] {
  if (!state.connected) return [];
  const ticked = new Set(wanted);
  return state.channels.filter(c => ticked.has(c.id) && c.supported);
}
