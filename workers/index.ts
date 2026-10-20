// The Worker: everything unstream.stream serves.
//
// One Worker in front of the static SPA, running the same function handlers and the same
// server-rendered pages that ran on Netlify Functions and Netlify Edge Functions. What changed in
// this move is where the code runs; what it does is unchanged (see "Lift and shift first,
// simplify second" in docs/specs/infrastructure-independence-plan.md).
//
// A request is answered by exactly one of these, in this order:
//
//   1. a static asset, when one exists at that path — free, and never reaches the code below;
//   2. the route table (workers/routes.ts), first match wins:
//        function      → a handler from api/functions/, through the Lambda-event adapter
//        edge          → a server-rendered page from api/edge/
//        redirect      → a 301
//        missing-asset → a real 404, so a superseded chunk is a fetch error and not a MIME error
//        spa           → the SPA shell
//   3. the SPA shell, if nothing matched at all.
//
// Everything that leaves here goes through `withSiteHeaders`, which applies the site CSP.
// Static files get their headers from apps/web/public/_headers instead, because Workers serves
// them without running the Worker at all — see workers/response-headers.ts.

import * as Sentry from '@sentry/cloudflare';

import { withBackgroundDispatcher, type BackgroundDispatcher } from '../api/lib/background.ts';
import { sentryOptions } from '../api/lib/sentry.ts';
import { toFunctionEvent, toResponse, type FunctionEvent } from './function-adapter.ts';
import { FUNCTION_HANDLERS } from './function-handlers.ts';
import { EDGE_RENDERERS } from './edge-renderers.ts';
import { matchRoute } from './routes.ts';
import { CRON_FUNCTIONS, parseBackgroundMessage, type BackgroundMessage } from './background-queue.ts';
import { withEdgeCache } from './edge-cache.ts';
import { withSiteHeaders } from './response-headers.ts';

// `Env` is generated into worker-configuration.d.ts from wrangler.jsonc's bindings and vars, so
// the ASSETS binding and the URL var are typed from the config itself and can't drift from it.
// Secrets are read through `process.env` instead, the way all 66 handlers already read their
// configuration — nodejs_compat populates it from the Worker's vars and secrets alike.

/**
 * Netlify exposed every function at `/.netlify/functions/<name>` whether or not it had a
 * friendly route, and three callers depend on that: the GitHub Actions schedules, the internal
 * handshakes, and anything still pointed at the old paths during the cutover window. Keeping the
 * prefix costs one `startsWith` and means nothing outside this repository has to change on the
 * day we switch DNS over — which is also what makes the rollback a DNS change and nothing more.
 *
 * It goes when Phase 1b moves the schedules to Cron Triggers and the crawls to Queues.
 */
const LEGACY_FUNCTION_PREFIX = '/.netlify/functions/';

/** The one `URL` value that means "this is the real site", as api/lib/sentry.ts also reads it. */
const PRODUCTION_SITE_URL = 'https://unstream.stream';

/**
 * Why scheduled work must not run here, or null when it may.
 *
 * Two gates, both fail-closed, because every runtime that is not the production Worker still
 * talks to the *production* Supabase — a sweep writes real catalogue rows and the tips notifier
 * sends real notifications, so running one from staging or a laptop is not a dry run.
 *
 * - `SCHEDULED_JOBS_ENABLED` is deliberately absent from wrangler.jsonc's `vars`, so it has to be
 *   set on the production Worker and nowhere else. Same shape as `RELEASE_CATALOG_ENABLED`, for
 *   the same reason. This is the gate that holds under `wrangler dev`, where `URL` is inherited
 *   from the top-level vars and therefore *does* say production.
 * - `URL` catches a staging deploy that was handed the variable by accident.
 *
 * It returns the reason rather than a boolean so the log line says which gate stopped it: a job
 * silently not running is the failure this whole phase exists to remove.
 */
function scheduledWorkRefusal(): string | null {
  if (process.env.SCHEDULED_JOBS_ENABLED !== 'true') {
    return 'SCHEDULED_JOBS_ENABLED is not "true" — this is not the production Worker';
  }
  if (process.env.URL !== PRODUCTION_SITE_URL) {
    return `URL is ${process.env.URL ?? 'unset'}, not production`;
  }
  return null;
}

/**
 * `social-card` can't run here: it reads its fonts off disk and loads resvg's WebAssembly binary.
 * It is also already on its way out — #649 moved card drawing into the weekly generator, and the
 * endpoint survives only until the last Buffer post scheduled against it has published. Until
 * then its requests go to the Netlify site, which stays up through the cutover window anyway for
 * rollback. Buffer is the only caller, and it fetches each card once.
 *
 * Delete this, the route, and the function together (see the header of api/functions/social-card.ts).
 */
const PROXIED_TO_NETLIFY: ReadonlyArray<string> = ['/api/social-card/'];

/** Path prefixes that only ever resolve to a handler or a renderer, never to a file on disk. */
const NEVER_AN_ASSET: ReadonlyArray<string> = ['/api/', '/.netlify/functions/', '/a/', '/u/', '/tip/', '/feed/', '/digest/'];

function isNeverAnAsset(pathname: string): boolean {
  return NEVER_AN_ASSET.some((prefix) => pathname.startsWith(prefix));
}

function serveSpa(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // The SPA shell, not whatever this path is. Static assets' own `single-page-application`
  // handling would do this too, but asking for it explicitly keeps the three places that need
  // the shell — the catch-all, an unmatched path, and a renderer's `context.next()` — saying
  // the same thing.
  //
  // A plain GET, deliberately: `new Request(url, request)` would carry the caller's method and
  // body across, so a POST to an unmatched path would be POSTed at the asset binding and answered
  // 405 instead of returning the shell the way Netlify's catch-all rewrite did.
  return env.ASSETS.fetch(new URL('/index.html', url.origin).toString());
}

/**
 * Put a background function on the queue.
 *
 * Returns false — so the caller falls back to its own path — when the function isn't one we have,
 * or when the enqueue itself fails. It does NOT return true for work that merely started: a queue
 * accepting a message is a promise to run it, with retries and a dead-letter queue behind it,
 * which is the whole reason this is a queue and not `ctx.waitUntil`.
 */
function backgroundDispatcher(env: Env): BackgroundDispatcher {
  return async (functionName, body) => {
    if (!Object.hasOwn(FUNCTION_HANDLERS, functionName)) return false;

    try {
      await env.BACKGROUND_QUEUE.send({ functionName, body } satisfies BackgroundMessage);
      return true;
    } catch (error) {
      console.error(
        `[worker] could not enqueue ${functionName}:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  };
}

/**
 * Run one background function, as the queue consumer and the cron handler both need to.
 *
 * The handler gets the event it would have got over HTTP, internal secret included, so its own
 * `isInternalRequest` check runs exactly as it does in production rather than being bypassed.
 */
async function runBackgroundFunction(functionName: string, body: string): Promise<void> {
  const handler = Object.hasOwn(FUNCTION_HANDLERS, functionName) ? FUNCTION_HANDLERS[functionName] : undefined;
  if (!handler) throw new Error(`no such background function: ${functionName}`);

  const secret = process.env.INTERNAL_FUNCTION_SECRET;
  if (!secret) throw new Error(`INTERNAL_FUNCTION_SECRET is not set, so ${functionName} cannot authenticate`);

  const origin = process.env.URL ?? 'https://unstream.stream';
  const event: FunctionEvent = {
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body,
    isBase64Encoded: false,
    queryStringParameters: {},
    path: `${LEGACY_FUNCTION_PREFIX}${functionName}`,
    rawUrl: `${origin}${LEGACY_FUNCTION_PREFIX}${functionName}`,
  };

  const result = await handler(event);
  // A background function reports its own failures and answers 200 either way, so a non-2xx here
  // is the dispatcher's problem — auth, a bad body — and is worth a retry rather than a shrug.
  if (result && result.statusCode >= 400) {
    throw new Error(`${functionName} answered ${result.statusCode}`);
  }
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (PROXIED_TO_NETLIFY.some((prefix) => url.pathname.startsWith(prefix))) {
    const siteName = process.env.SITE_NAME;
    if (siteName) {
      const target = new URL(url.pathname + url.search, `https://${siteName}.netlify.app`);
      // A bare GET, not `new Request(target, request)`: these are public card images fetched by
      // Buffer, and there is no reason to forward a caller's cookies or Authorization header to
      // another host just because the path matched.
      return fetch(target.toString(), { method: 'GET' });
    }
    return new Response('Not found', { status: 404 });
  }

  if (url.pathname.startsWith(LEGACY_FUNCTION_PREFIX)) {
    const name = url.pathname.slice(LEGACY_FUNCTION_PREFIX.length).replace(/\/$/, '');
    // `hasOwn`, not a bare index: the map is an object literal, so `/.netlify/functions/constructor`
    // would otherwise resolve to Object's own constructor and be invoked as a handler.
    const handler = Object.hasOwn(FUNCTION_HANDLERS, name) ? FUNCTION_HANDLERS[name] : undefined;
    if (!handler) return new Response('Function not found', { status: 404 });
    return toResponse(await handler(await toFunctionEvent(request)));
  }

  const matched = matchRoute(url.pathname);
  if (!matched) return serveSpa(request, env);

  switch (matched.route.kind) {
    case 'function': {
      const handler = Object.hasOwn(FUNCTION_HANDLERS, matched.route.name)
        ? FUNCTION_HANDLERS[matched.route.name]
        : undefined;
      if (!handler) return new Response('Function not found', { status: 404 });
      const run = async () => toResponse(await handler(await toFunctionEvent(request)));
      return matched.route.cache ? withEdgeCache(request, ctx, run) : run();
    }

    case 'edge': {
      const render = Object.hasOwn(EDGE_RENDERERS, matched.route.name)
        ? EDGE_RENDERERS[matched.route.name]
        : undefined;
      if (!render) return serveSpa(request, env);
      // `context.next()` means "not mine — serve the SPA". Every renderer decides that per
      // request, before any database query: one route, one renderer.
      const renderPage = () => render(request, { next: () => serveSpa(request, env) });
      return matched.route.cache ? withEdgeCache(request, ctx, renderPage) : renderPage();
    }

    case 'redirect': {
      const target = new URL(matched.route.to, url.origin);
      // Netlify appended the incoming query string when the destination had none, so a
      // /plus?utm_source=… link kept its attribution through the redirect. Dropping it loses
      // every campaign parameter on the retired /guides URLs and on /plus, silently.
      if (!target.search) target.search = url.search;
      return Response.redirect(target.toString(), matched.route.status);
    }

    case 'missing-asset': {
      // Only reached when the asset genuinely isn't there — real files are served above, before
      // routing. A 404 rather than the SPA shell: see the note on `missing-asset` in routes.ts.
      return new Response('Not found', { status: 404 });
    }

    case 'spa':
      return serveSpa(request, env);
  }
}

/**
 * Wrapped in Sentry's Worker handler, which starts a client per request and flushes it through
 * `waitUntil`. That is what makes the functions' `Sentry.captureException` calls reach the
 * project at all — @sentry/cloudflare has no `init()` of its own (see api/lib/sentry.ts).
 *
 * It also reports anything that escapes `fetch` below, which `withSentry` inside each handler
 * cannot: a throw while routing, or in the adapter.
 */
export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cloudflare serves a matching asset *before* this Worker is invoked at all, so real files
    // already win over routes without help from here — this probe is the fallback for anything
    // the platform passed through, and the reason /assets/* can 404 rather than fall into the
    // SPA. It is NOT what applies headers to static files: those never reach this code, which is
    // why apps/web/public/_headers exists and must stay.
    //
    // GET and HEAD only, and not merely as an optimisation: handing the request to another
    // fetcher consumes its body, so probing first would leave every POST, PUT and DELETE with a
    // body that `toFunctionEvent` can no longer read.
    //
    // Skipped for the prefixes that can never name a file, so a search — already fanning out to
    // ~17 upstreams against a per-request subrequest budget — doesn't spend a round trip finding
    // that out. Adding a static file under one of these would need this list revisited.
    if ((request.method === 'GET' || request.method === 'HEAD') && !isNeverAnAsset(url.pathname)) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return withSiteHeaders(asset);
    }

    const response = await withBackgroundDispatcher(backgroundDispatcher(env), () =>
      route(request, env, ctx),
    );
    return withSiteHeaders(response);
  },

  /**
   * The queue consumer: 15 minutes per invocation, which is the budget a catalogue crawl needs
   * and the reason this exists.
   *
   * A thrown error retries the message (three times, then the dead-letter queue), so failures
   * are visible as a backlog rather than as nothing happening — the thing that made "the six
   * days nothing was catalogued" invisible. Messages are acked one at a time rather than with
   * `batch.ackAll()`, so one poisoned message can't discard the rest of its batch.
   */
  async queue(batch: MessageBatch<unknown>, _env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      const parsed = parseBackgroundMessage(message.body);
      if (!parsed) {
        console.error('[worker] dropping an unreadable queue message:', JSON.stringify(message.body)?.slice(0, 200));
        message.ack();
        continue;
      }

      try {
        await runBackgroundFunction(parsed.functionName, parsed.body);
        message.ack();
      } catch (error) {
        console.error(
          `[worker] queued ${parsed.functionName} failed (attempt ${message.attempts}):`,
          error instanceof Error ? error.message : String(error),
        );
        message.retry();
      }
    }
  },

  /**
   * Cron Triggers, replacing the two GitHub Actions schedules.
   *
   * Guarded on the production URL as well as by the empty `crons` on the staging environment:
   * staging shares one production Supabase with the real site, so a sweep running there would
   * write real catalogue rows and a tips notifier would send real notifications. Structural
   * first, runtime second — and it says so out loud rather than skipping silently, because a
   * job that never starts never fails.
   */
  async scheduled(event: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
    const functionName = CRON_FUNCTIONS[event.cron];
    if (!functionName) {
      console.error(`[worker] no function mapped to cron "${event.cron}" — check wrangler.jsonc`);
      return;
    }

    const refusal = scheduledWorkRefusal();
    if (refusal) {
      console.warn(`[worker] skipping scheduled ${functionName}: ${refusal}`);
      return;
    }

    ctx.waitUntil(
      runBackgroundFunction(functionName, JSON.stringify({ trigger: 'scheduled' })).catch((error: unknown) => {
        console.error(
          `[worker] scheduled ${functionName} failed:`,
          error instanceof Error ? error.message : String(error),
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>);
