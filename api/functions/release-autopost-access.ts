// Who may use release autopost (docs/specs/release-autopost-spec.md, "Who can use it").
//
// **Every release autopost endpoint, page and scheduled run checks this first.** While the
// `releaseAutopost` flag is off, which is how it ships, only the admin account gets in, so the
// whole feature can be tested end to end on Brandon's own catalogue and nobody else can reach
// any of it. The tips (`canSetUpTips`) and curator posts (`canUseCuratorPosts`) precedent.
//
// This is only the feature gate. Acting on an artist also needs that artist's verified claim,
// checked separately by each endpoint.

import { getFeatureFlag } from './feature-flags';

/**
 * Whether this signed-in account may use release autopost: the admin account (ADMIN_EMAIL)
 * always, everyone else only once the `releaseAutopost` flag is on. The flag fails closed, so a
 * Redis outage leaves it admin-only.
 */
export async function canUseReleaseAutopost(email: string | null | undefined): Promise<boolean> {
  const admin = process.env.ADMIN_EMAIL;
  if (admin && email && email.toLowerCase() === admin.toLowerCase()) return true;
  return getFeatureFlag('releaseAutopost');
}
