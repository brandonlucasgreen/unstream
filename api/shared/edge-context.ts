// What a server-rendered page gets besides the request.
//
// These seven renderers were Netlify Edge Functions, which are Deno and take a `Context` from
// `https://edge.netlify.com`. They are already Web-standard code — `Request` in, `Response` out —
// so the whole Netlify surface they ever used was `context.next()`. This is that, and nothing
// else, so the renderers themselves read the same on Workers as they did on Deno.
//
// `next()` means "this request isn't mine — serve the SPA." On Netlify it continued down the
// edge chain to the static file; here it fetches the SPA shell from the Worker's static assets.
// The meaning is unchanged and so is the rule it exists for: every one of these renderers
// decides, per request and before any database query, whether it answers or the SPA does. One
// route, one renderer (CLAUDE.md, and docs/postmortems/UNS-100-bifurcation-retro.md for what the
// other shape cost).

export interface Context {
  next: () => Promise<Response>;
}

/** A renderer: answers the request, or calls `context.next()` to let the SPA have it. */
export type EdgeRenderer = (request: Request, context: Context) => Promise<Response>;

/**
 * Read a configuration value, on either runtime these pages run on.
 *
 * They run in two places until the cutover is done: Netlify's edge, which is Deno and has
 * `Deno.env`, and the Worker, which has `process.env` through nodejs_compat. Neither global
 * exists on the other runtime, so both lookups are guarded — a bare `process.env` here would
 * throw on Deno and take every server-rendered page down with it, and the Netlify site has to
 * keep working for the whole rollback window.
 *
 * Deno first, because that is the one still serving production. Delete the Deno branch when the
 * Netlify site is retired.
 */
export function edgeEnv(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }).Deno;
  if (deno?.env?.get) return deno.env.get(name);
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}
