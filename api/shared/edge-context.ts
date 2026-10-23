// What a server-rendered page gets besides the request.
//
// These seven renderers are Netlify Edge Functions, which run on Deno. They are Web-standard
// code — `Request` in, `Response` out — and the only part of Netlify's `Context` they use is
// `context.next()`, so this declares just that rather than importing Netlify's type. It also keeps
// them portable: nothing in them is tied to one host.
//
// `next()` means "this request isn't mine — serve the SPA": on Netlify it continues down the edge
// chain to the static file. The rule it exists for: every one of these renderers
// decides, per request and before any database query, whether it answers or the SPA does. One
// route, one renderer (CLAUDE.md, and docs/postmortems/UNS-100-bifurcation-retro.md for what the
// other shape cost).

export interface Context {
  next: () => Promise<Response>;
}

/** A renderer: answers the request, or calls `context.next()` to let the SPA have it. */
export type EdgeRenderer = (request: Request, context: Context) => Promise<Response>;

/**
 * Read a configuration value.
 *
 * Netlify's edge is Deno, which has `Deno.env` and no `process`; the unit tests import these
 * pages under Node, which has `process.env` and no `Deno`. Both lookups are guarded, because a bare
 * `process.env` here would throw on Deno and take every server-rendered page down with it.
 */
export function edgeEnv(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }).Deno;
  if (deno?.env?.get) return deno.env.get(name);
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}
