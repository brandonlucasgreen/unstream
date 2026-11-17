// What the Promote endpoints check once the wrapper (http/endpoint.ts) has signed the caller in,
// counted the request and refused a session that still owes its second step: the feature gate
// (`canUseReleaseAutopost`) and the artist's own verified claim. Used by the asset library
// (artist-promote-assets.ts) and campaigns (artist-campaigns.ts); artist-promote.ts makes the
// same checks inline, in the same order.
//
// Both endpoints are declared with `auth: 'accountWithSecondStep'` because they act as the
// artist — they schedule posts from their accounts and settle their Buffer organization — so a
// half-finished sign-in is refused on them as it is on artist-promote.

import type { EndpointResult } from './http/endpoint';
import { canUseReleaseAutopost } from './release-autopost-access';
import { getAutopostArtist, type AutopostArtist } from './release-autopost-db';

/** The artist, or the answer to send instead. */
export async function authorizePromoteRequest(
  user: { userId: string; email: string },
  query: Record<string, string | undefined>,
): Promise<{ artist: AutopostArtist } | { response: EndpointResult }> {
  // The gate first, so nothing about the feature, or the artist, is said to anyone it excludes.
  if (!(await canUseReleaseAutopost(user.email))) return { response: { status: 200, body: { available: false } } };

  const slug = query.artist;
  if (!slug) return { response: { status: 400, body: { error: 'artist is required' } } };
  const artist = await getAutopostArtist({ slug });
  if (!artist) return { response: { status: 404, body: { error: 'Artist not found' } } };
  if (artist.verifiedOwnerId !== user.userId) return { response: { status: 403, body: { error: 'Only this artist’s verified owner can do this' } } };
  return { artist };
}
