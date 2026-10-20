import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Worker's bundle swaps two imports that the source states differently, and both swaps are
 * invisible in the source file that does the importing:
 *
 * - `https://esm.sh/@supabase/supabase-js@2` in api/edge/*.ts, because those pages also run on
 *   Netlify's Deno edge for as long as that site is kept for rollback.
 * - `@sentry/node` in api/lib/sentry.ts, because only the Node SDK binds a client with `init()`
 *   and Netlify is still production — on Workers the client comes from `Sentry.withSentry`.
 *
 * Getting either wrong fails quietly: a green typecheck with a Worker that can't reach the
 * database, or a Worker that silently reports nothing. So the rules are asserted rather than
 * assumed.
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
const pkg = readJsonc(join(repoRoot, 'package.json'));
const dependencyNames = [
  ...Object.keys((pkg.dependencies ?? {}) as Record<string, string>),
  ...Object.keys((pkg.devDependencies ?? {}) as Record<string, string>),
];
const paths = ((workersTsconfig.compilerOptions as Record<string, unknown>).paths ?? {}) as Record<string, string[]>;

describe('wrangler and TypeScript agree on every aliased specifier', () => {
  it('aliases only to packages that are actually installed', () => {
    for (const target of Object.values(alias)) {
      expect(dependencyNames, `${target} is aliased but not a dependency`).toContain(target);
    }
  });

  /**
   * A specifier TypeScript cannot resolve on its own — a URL import — needs a `paths` entry
   * pointing at the same package wrangler swaps in, or the typecheck breaks. A bare package
   * specifier must NOT have one: `@sentry/node` has to keep resolving to the Node SDK's types,
   * which is what makes `typeof init === 'function'` meaningful.
   */
  it('gives every unresolvable specifier a matching tsconfig path, and no others', () => {
    for (const [specifier, target] of Object.entries(alias)) {
      if (specifier.includes('://')) {
        expect(paths[specifier]?.[0], specifier).toBe(`../node_modules/${target}`);
      } else {
        expect(paths[specifier], `${specifier} should resolve to its own types`).toBeUndefined();
      }
    }
  });
});

describe('every aliased specifier is one the code actually imports', () => {
  it('still finds the Supabase URL import the alias exists for', () => {
    // If this fails, the edge pages moved to a bare npm import — which is the cutover change.
    // Delete the alias, its path and this assertion together with it.
    const edgeSource = readFileSync(join(repoRoot, 'api', 'edge', 'release-page.ts'), 'utf8');
    expect(edgeSource).toContain('https://esm.sh/@supabase/supabase-js@2');
    expect(alias).toHaveProperty('https://esm.sh/@supabase/supabase-js@2');
  });

  it('still finds the @sentry/node import the alias exists for', () => {
    // api/lib/sentry.ts must keep importing the Node SDK: it is what binds a client on Netlify,
    // which is production until the cutover. If this moves to @sentry/cloudflare, the alias and
    // the `typeof init === 'function'` guard go with it.
    const sentrySource = readFileSync(join(repoRoot, 'api', 'lib', 'sentry.ts'), 'utf8');
    expect(sentrySource).toContain("from '@sentry/node'");
    expect(alias).toHaveProperty('@sentry/node');
  });
});
