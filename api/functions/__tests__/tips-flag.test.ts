// The tips gates' decision, shared by the node functions and the Deno edge renderer (UNS-215).
//
// The two runtimes read the flags through completely different code — the node side through the
// Upstash SDK in feature-flags.ts, the edge side through a REST fetch — so the only thing keeping
// them in agreement is this function and the hash key beside it. Locked here: only the exact
// string "on" turns a flag on, and every way a read can go wrong (missing hash, missing field, a
// thrown read passed through as an Error) reads as off.
//
// UNS-215 split one `tips` flag into `tipsArtists` (artist onboarding) and `tipsFans` (every
// fan-facing surface). Both field names are asserted against the registry below: a typo in either
// would otherwise be a flag that silently never turns on.

import { describe, it, expect, vi } from 'vitest';

// Importing feature-flags.ts (in the last describe) pulls in redis.ts, and the Netlify build
// environment carries production Upstash credentials — see cache-should-cache.test.ts. Nothing
// here calls Redis; the stub makes that a fact rather than an assumption.
vi.mock('../redis', () => ({ getRedis: () => null, reportRedisFailure: vi.fn() }));

import {
  FLAGS_HASH_KEY,
  TIPS_ARTISTS_FLAG_FIELD,
  TIPS_FANS_FLAG_FIELD,
  flagIsOn,
} from '../../shared/tips-flag';

describe('flagIsOn', () => {
  it('is on only for the exact stored value "on"', () => {
    expect(flagIsOn('on')).toBe(true);
  });

  it.each([['off'], ['ON'], ['On'], ['true'], ['1'], [1], [true], [''], [null], [undefined]])(
    'is off for %j',
    (raw) => {
      expect(flagIsOn(raw)).toBe(false);
    },
  );

  it('is off when the hash, or the field in it, is missing', () => {
    // Both arrive as null/undefined — a missing hash and a missing field are the same answer.
    expect(flagIsOn(null)).toBe(false);
    expect(flagIsOn(undefined)).toBe(false);
  });

  it('is off when the read itself failed', () => {
    // The edge caller passes the failure straight through rather than pre-flattening it, so an
    // Error has to be a value this function can safely answer.
    expect(flagIsOn(new Error('ECONNRESET'))).toBe(false);
    expect(flagIsOn({ error: 'UPSTASH_REDIS_REST_URL is not configured' })).toBe(false);
  });
});

describe('the shared key names', () => {
  it('matches the hash the node flag store reads', async () => {
    const { FLAGS_HASH_KEY: nodeKey } = await import('../feature-flags');
    expect(nodeKey).toBe(FLAGS_HASH_KEY);
  });

  // What must not drift is that *these* two field names are registered and spelled the way the
  // edge side spells them. The registry itself is free to grow — `curatorPosts` joined it in
  // 2026-10 — so this asserts membership rather than the whole list, which would fail for every
  // unrelated flag. The whole list is pinned, exhaustively, in feature-flags.test.ts.
  it('registers the fields the edge side reads, spelled identically', async () => {
    const { FEATURE_FLAGS } = await import('../feature-flags');
    expect([...FEATURE_FLAGS]).toContain(TIPS_ARTISTS_FLAG_FIELD);
    expect([...FEATURE_FLAGS]).toContain(TIPS_FANS_FLAG_FIELD);
    expect(TIPS_ARTISTS_FLAG_FIELD).toBe('tipsArtists');
    expect(TIPS_FANS_FLAG_FIELD).toBe('tipsFans');
  });
});
