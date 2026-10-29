// Feature flags: one Redis hash (`feature-flags`), field = flag name, value exactly "on"/"off".
//
// Rudimentary on purpose. A flag is on when its field is the string "on" and missing otherwise;
// there is no rollout percentage, no per-user targeting and no expiry.
//
// FAIL CLOSED, and that is the one thing this module does differently from cache.ts and
// ratelimit.ts. Those fail open because a Redis outage must not break a request for a fan. Here
// the failure mode is inverted: a flag that reads "on" by accident ships a half-built feature to
// everyone, while a flag that reads "off" by accident only keeps a finished feature invisible
// until the next read. So every failure path — Redis unconfigured, Redis erroring, circuit open,
// hash missing, field missing — resolves to false, i.e. the feature is visible to admins only.
//
// The cost of that choice is that a Redis outage is silent for readers unless it is reported, so
// every caught error goes through reportRedisFailure() and reaches Sentry.

import { getRedis, reportRedisFailure } from './redis';
// The hash key and the "is this value on" test live in api/shared so the Deno edge functions,
// which cannot import this module, read the same key and apply the same test (UNS-215). The
// key is re-exported below: it is still this module's public constant.
import { FLAGS_HASH_KEY as SHARED_FLAGS_HASH_KEY, flagIsOn } from '../shared/tips-flag';

/**
 * Every flag that exists — the single source of truth.
 *
 * Adding a name here creates the flag (it starts off). The registry, not the Redis hash, decides
 * what exists: getFeatureFlags() ignores fields with names not in this list, so a flag deleted
 * from the code cannot be resurrected by a stale field left in Redis, and setFeatureFlag() is
 * only ever called with a name from here.
 *
 * UNS-215: `tipsArtists` gates the artist side (starting Stripe onboarding, switching tips on)
 * and `tipsFans` gates every fan-facing surface. They are independent on purpose; the thing that
 * limits who can actually be paid is the admin approval gate, not either flag.
 *
 * `curatorPosts` gates the curator compose tool end to end: connecting a Buffer account, the
 * compose page, and the endpoints behind it. Off, a curator can neither connect nor post, and
 * the page is not reachable — which is the state it ships in.
 *
 * `releaseAutopost` gates release autopost and release campaigns end to end
 * (docs/specs/release-autopost-spec.md): every endpoint, the Promote tab, and the sweep that
 * posts. Off, only the admin account can reach any of it (`canUseReleaseAutopost`).
 */
export const FEATURE_FLAGS = ['tipsArtists', 'tipsFans', 'curatorPosts', 'releaseAutopost'] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/** Every known flag and whether it is live to everyone. */
export type FeatureFlagMap = Record<FeatureFlag, boolean>;

/** The one hash. Field = flag name, value = "on" | "off". */
export const FLAGS_HASH_KEY = SHARED_FLAGS_HASH_KEY;

/**
 * Thrown by setFeatureFlag when the value could not be written because Redis is unavailable.
 * Callers answer 503 — a write that did not land must never look like a successful toggle.
 */
export class FeatureFlagStoreUnavailableError extends Error {
  constructor() {
    super('Feature flag store is unavailable');
    this.name = 'FeatureFlagStoreUnavailableError';
  }
}

/** True when `name` is a flag this build knows about. */
export function isFeatureFlag(name: string): name is FeatureFlag {
  return (FEATURE_FLAGS as readonly string[]).includes(name);
}

/** The map every failure path returns: known, and off. */
function allFlagsOff(): FeatureFlagMap {
  return Object.fromEntries(FEATURE_FLAGS.map((flag) => [flag, false])) as FeatureFlagMap;
}

/**
 * Read every flag. Never throws: an unreadable store means every flag is off.
 */
export async function getFeatureFlags(): Promise<FeatureFlagMap> {
  const flags = allFlagsOff();

  const redis = getRedis();
  if (!redis) return flags;

  let stored: Record<string, unknown> | null;
  try {
    stored = await redis.hgetall<Record<string, unknown>>(FLAGS_HASH_KEY);
  } catch (error) {
    reportRedisFailure(`${FLAGS_HASH_KEY}.getFeatureFlags`, error);
    return allFlagsOff();
  }

  if (!stored) return flags;

  for (const [name, value] of Object.entries(stored)) {
    // Unknown names are ignored rather than reported: they are how a flag looks between being
    // removed from FEATURE_FLAGS and being cleaned out of Redis.
    if (isFeatureFlag(name) && flagIsOn(value)) flags[name] = true;
  }
  return flags;
}

/** Read one flag. False — admin-only — whenever the store cannot be read. */
export async function getFeatureFlag(name: FeatureFlag): Promise<boolean> {
  return (await getFeatureFlags())[name];
}

/**
 * Write one flag. Throws FeatureFlagStoreUnavailableError when Redis is unavailable, so the
 * caller can answer 503 instead of reporting a toggle that never happened.
 */
export async function setFeatureFlag(name: FeatureFlag, enabled: boolean): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new FeatureFlagStoreUnavailableError();

  try {
    await redis.hset(FLAGS_HASH_KEY, { [name]: enabled ? 'on' : 'off' });
  } catch (error) {
    reportRedisFailure(`${FLAGS_HASH_KEY}.setFeatureFlag`, error);
    throw new FeatureFlagStoreUnavailableError();
  }
}
