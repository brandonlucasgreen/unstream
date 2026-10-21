import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Every file in `api/edge/` is an edge function to Netlify.** `netlify.toml` points
 * `edge_functions` at that directory, and the bundler requires each file in it to default-export
 * a handler — a shared helper with no default export fails the build with "Default export in
 * '…' must be a function".
 *
 * That failure is invisible everywhere else: it is not a type error, no test exercises it, and
 * the Cloudflare Worker bundles the same files happily because it imports them by name. It
 * surfaces only in a Netlify build — and since a failed build blocks the deploy, putting a
 * helper there stops *every* deploy until someone notices.
 *
 * It happened: `edge-context.ts` was added here during the Worker port and caught by a deploy
 * preview rather than by anything in CI. Shared code for the renderers belongs in `api/shared/`,
 * which both Deno and Node already import from.
 */
describe('api/edge/ holds nothing but edge functions', () => {
  const edgeDir = join(__dirname, '..', '..', 'edge');
  const files = readdirSync(edgeDir).filter((name) => name.endsWith('.ts'));

  it('finds the renderers', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s default-exports a handler', (name) => {
    const source = readFileSync(join(edgeDir, name), 'utf8');
    expect(source).toMatch(/export default (async )?function|export default \w+/);
  });
});
