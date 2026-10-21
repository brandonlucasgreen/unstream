import { describe, it, expect, afterEach } from 'vitest';

import { edgeEnv } from '../../api/shared/edge-context.ts';

/**
 * The server-rendered pages read their configuration through `edgeEnv` because they run on two
 * runtimes at once until the Netlify site is retired: Deno at Netlify's edge, which has
 * `Deno.env` and no `process`, and the Worker, which has `process.env` and no `Deno`.
 *
 * Reading the wrong one doesn't degrade — it throws a ReferenceError on the first request and
 * takes every artist, release and shared-list page with it. So both shapes are pinned here.
 */
const globals = globalThis as { Deno?: unknown; process?: unknown };

afterEach(() => {
  delete globals.Deno;
});

describe('edgeEnv', () => {
  it('reads Deno.env when running on Netlify’s edge', () => {
    globals.Deno = { env: { get: (key: string) => (key === 'SUPABASE_URL' ? 'https://deno.example' : undefined) } };

    expect(edgeEnv('SUPABASE_URL')).toBe('https://deno.example');
  });

  it('reads process.env when running on the Worker', () => {
    // No Deno global here, which is the Worker’s shape.
    process.env.EDGE_ENV_PROBE = 'from-process';
    try {
      expect(edgeEnv('EDGE_ENV_PROBE')).toBe('from-process');
    } finally {
      delete process.env.EDGE_ENV_PROBE;
    }
  });

  it('prefers Deno when both exist, since that is the runtime still serving production', () => {
    process.env.EDGE_ENV_PROBE = 'from-process';
    globals.Deno = { env: { get: () => 'from-deno' } };
    try {
      expect(edgeEnv('EDGE_ENV_PROBE')).toBe('from-deno');
    } finally {
      delete process.env.EDGE_ENV_PROBE;
    }
  });

  it('returns undefined for a value neither runtime has', () => {
    expect(edgeEnv('DEFINITELY_NOT_SET_ANYWHERE')).toBeUndefined();
  });
});
