// What goes on the background queue, and which schedule runs what.
//
// Separate from workers/index.ts on purpose: the entry point statically imports all 66 handlers
// and all 7 server-rendered pages, so anything that wants to read these — a test, above all —
// would drag the whole Worker in with it. These are the parts with no dependencies.

/** What travels on the queue: the function to run and the body it would have been POSTed. */
export interface BackgroundMessage {
  functionName: string;
  body: string;
}

/**
 * Read a queue message back, or null when it isn't one.
 *
 * A message is data that was serialised by a *previous* deploy, so its shape is an assumption
 * rather than a guarantee: a rename, a rollback, or a hand-published message all produce
 * something this doesn't recognise. Retrying those forever would fill the dead-letter queue with
 * work nothing can do, so an unreadable message is dropped with a line in the log instead.
 */
export function parseBackgroundMessage(raw: unknown): BackgroundMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const { functionName, body } = raw as Record<string, unknown>;
  if (typeof functionName !== 'string' || typeof body !== 'string') return null;
  return { functionName, body };
}

/**
 * The schedules, by the cron expression wrangler.jsonc fires them on.
 *
 * These were GitHub Actions POSTing to the Netlify host by name, which they did deliberately:
 * Bot Fight Mode on the unstream.stream zone challenged the runner's curl and cost six days of
 * cataloguing. A Cron Trigger has no HTTP hop to be challenged.
 *
 * A cron here with no entry fires on schedule and does nothing, which is exactly the silence this
 * phase exists to remove — `workers/__tests__/background-jobs.test.ts` checks the two lists match.
 */
export const CRON_FUNCTIONS: Record<string, string> = {
  '0 1,13 * * *': 'recatalog-sweep',
  '*/30 * * * *': 'tips-review-notify',
};
