// Work that outlives the response.
//
// On Netlify this was always an HTTP handshake: a function POSTed to a *background function* and
// treated the 202 as "accepted". That shape exists because Lambda freezes the process the moment
// the handler returns, so a promise left running is simply killed — the work had to happen in
// another invocation, and the only way to start one was over HTTP.
//
// On Workers the handshake isn't needed, and more importantly it isn't *safe*: the call would
// leave Cloudflare and come straight back into our own zone, and free-plan Bot Fight Mode
// challenges requests like that with no way to exempt them. That is not hypothetical — it
// answered every function-to-function call with "Just a moment…" from 2026-10-12 to 2026-10-18,
// the callers read the 403 as delivered, and release cataloguing silently did nothing for six
// days (api/lib/internal-origin.ts, and "The six days nothing was catalogued" in
// docs/engineering-history.md). Putting the app on that zone would have aimed the handshake back
// into it.
//
// So on Workers a dispatcher is installed for the duration of each request, and a caller that
// finds one hands it the function name and body it would have POSTed. The Worker puts that on a
// **queue**, whose consumer gets 15 minutes — a catalogue crawl is budgeted for 9 to 13, and
// `ctx.waitUntil` allows 30 seconds, so the queue is the only budget here that fits. Callers that
// find no dispatcher — Node, the tests, `npm run dev` under Netlify during the cutover window —
// fall back to the handshake they already had, unchanged.
//
// **It is async, and the answer means something.** An earlier revision returned `true` the moment
// work was handed to `waitUntil`, so callers recorded acceptance for work that could still be
// cancelled; `me-bandcamp.ts` left a row claiming a sync that would never run. Awaiting the
// enqueue means `false` is an honest "this did not get accepted" and the caller's existing
// failure path handles it.
//
// `AsyncLocalStorage` rather than a module-level variable because one isolate handles several
// requests at once, and a shared slot would hand one request's work to another request's
// execution context. It is what Cloudflare supports for exactly this, and it needs `nodejs_compat`.

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Start a background function and say whether it was accepted.
 *
 * `false` means either "not here" or "could not be enqueued" — both leave the caller to fall
 * back to its HTTP handshake or its own failure path. `true` means a queue has it and will keep
 * retrying it, which is a promise `waitUntil` could not make.
 */
export type BackgroundDispatcher = (functionName: string, body: string) => Promise<boolean>;

const dispatcherStorage = new AsyncLocalStorage<BackgroundDispatcher>();

/** Run `fn` with `dispatcher` available to everything it calls, however deep. */
export function withBackgroundDispatcher<T>(dispatcher: BackgroundDispatcher, fn: () => T): T {
  return dispatcherStorage.run(dispatcher, fn);
}

/**
 * Hand a background function its work without an HTTP round trip, if this runtime can.
 *
 * Returns false when there is no dispatcher, which is the signal to use the HTTP handshake.
 */
export async function dispatchBackgroundFunction(functionName: string, body: string): Promise<boolean> {
  const dispatcher = dispatcherStorage.getStore();
  if (!dispatcher) return false;
  return dispatcher(functionName, body);
}
