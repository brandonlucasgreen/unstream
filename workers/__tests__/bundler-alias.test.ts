import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Supabase import in api/edge/*.ts is a URL, because those pages also still run on Netlify's
 * Deno edge for as long as that site is kept for rollback. Two separate tools have to be told
 * what that URL means here: wrangler, so it bundles the npm package, and TypeScript, so it can
 * find the types.
 *
 * If only one of them knows, the failure is lopsided and confusing — a green typecheck and a
 * Worker that can't reach the database, or a working Worker whose build fails. So they are
 * checked against each other, and against the imports that actually exist.
 */
const repoRoot = join(__dirname, '..', '..');

/** Strip // comments so JSON.parse can read a .jsonc / commented tsconfig. */
function readJsonc(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
  return JSON.parse(text);
}

const wrangler = readJsonc(join(repoRoot, 'wrangler.jsonc'));
const workersTsconfig = readJsonc(join(repoRoot, 'workers', 'tsconfig.json'));

const alias = (wrangler.alias ?? {}) as Record<string, string>;
const paths = ((workersTsconfig.compilerOptions as Record<string, unknown>).paths ?? {}) as Record<string, string[]>;

describe('wrangler and TypeScript resolve the same specifiers', () => {
  it('maps the same set of specifiers', () => {
    expect(Object.keys(paths).sort()).toEqual(Object.keys(alias).sort());
  });

  it('points each one at the same package', () => {
    for (const [specifier, target] of Object.entries(alias)) {
      expect(paths[specifier]?.[0]).toBe(`../node_modules/${target}`);
    }
  });
});

describe('every aliased specifier is one the code actually imports', () => {
  const edgeSources = readFileSync(join(repoRoot, 'api', 'edge', 'release-page.ts'), 'utf8');

  it('still finds the Supabase URL import the alias exists for', () => {
    // If this fails, the edge pages moved to a bare npm import — which is the cutover change.
    // Delete the alias, these paths and this file together with it.
    expect(edgeSources).toContain('https://esm.sh/@supabase/supabase-js@2');
    expect(alias).toHaveProperty('https://esm.sh/@supabase/supabase-js@2');
  });
});
