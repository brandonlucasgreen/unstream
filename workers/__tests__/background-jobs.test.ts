import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readJsonc } from './jsonc.ts';
import { CRON_FUNCTIONS, parseBackgroundMessage } from '../background-queue.ts';

/**
 * Phase 1b: the long jobs moved off `ctx.waitUntil` (30 seconds) onto a queue (15 minutes),
 * because a catalogue crawl is budgeted for 9 to 13 — and a crawl killed part-way still counts
 * as an attempt, so the artist is skipped for seven days with nothing reporting a failure.
 *
 * Most of what can go wrong here is configuration drifting from code, and none of it fails
 * loudly: a cron with no function mapped to it fires into nothing, and a consumer reading a
 * different queue than the producer writes leaves work that is accepted and never run.
 */
const repoRoot = join(__dirname, '..', '..');
const wrangler = readJsonc(join(repoRoot, 'wrangler.jsonc'));
const workerSource = readFileSync(join(repoRoot, 'workers', 'index.ts'), 'utf8');

const queues = wrangler.queues as { producers: { binding: string; queue: string }[]; consumers: { queue: string }[] };
const crons = (wrangler.triggers as { crons: string[] }).crons;

describe('the queue is wired end to end', () => {
  it('consumes the same queue it produces to', () => {
    // Different names would mean work accepted by the producer that no consumer ever reads.
    expect(queues.consumers.map((c) => c.queue)).toEqual(queues.producers.map((p) => p.queue));
  });

  it('binds the queue under the name the Worker reads', () => {
    expect(queues.producers[0].binding).toBe('BACKGROUND_QUEUE');
    expect(workerSource).toContain('env.BACKGROUND_QUEUE.send');
  });

  it('takes one message at a time, because one message is one whole crawl', () => {
    // Batching would put several 9-13 minute crawls inside one 15-minute invocation.
    expect((queues.consumers[0] as { max_batch_size?: number }).max_batch_size).toBe(1);
  });

  it('keeps crawls serial, because the pacing delays assume it', () => {
    // catalog-artist-background's per-artist and per-detail-fetch delays are the crawl budget.
    // Concurrency above 1 multiplies the real request rate at Bandcamp without changing one of them.
    expect((queues.consumers[0] as { max_concurrency?: number }).max_concurrency).toBe(1);
  });

  it('sends failures somewhere visible rather than dropping them', () => {
    expect((queues.consumers[0] as { dead_letter_queue?: string }).dead_letter_queue).toBeTruthy();
  });

  it('gives every named environment its own dead-letter queue too', () => {
    // `queues` isn't inherited, so an environment that restates its consumer can silently lose
    // the dead-letter queue — and production's must not collect another environment's failures.
    type Consumer = { dead_letter_queue?: string };
    const productionDlq = (queues.consumers[0] as Consumer).dead_letter_queue;
    for (const [name, env] of Object.entries(wrangler.env as Record<string, { queues?: { consumers?: Consumer[] } }>)) {
      const dlq = env.queues?.consumers?.[0]?.dead_letter_queue;
      expect(dlq, `env.${name} must declare its own dead-letter queue`).toBeTruthy();
      expect(dlq, `env.${name} must not share production's dead-letter queue`).not.toBe(productionDlq);
    }
  });
});

describe('every cron has a function, and every function a file', () => {
  const mapped = Object.entries(CRON_FUNCTIONS).map(([cron, fn]) => ({ cron, fn }));

  it('maps exactly the crons wrangler.jsonc fires', () => {
    // A cron with nothing mapped to it fires on schedule and does nothing, which is the shape of
    // failure this whole phase exists to remove.
    expect(mapped.map((m) => m.cron).sort()).toEqual([...crons].sort());
  });

  it.each(mapped.map((m) => [m.cron, m.fn] as const))('%s -> %s exists as a function', (_cron, fn) => {
    const files = readdirSync(join(repoRoot, 'api', 'functions'));
    expect(files).toContain(`${fn}.ts`);
  });

  it('keeps the cadences the GitHub workflows used', () => {
    // Changing these silently changes how often the site catalogues or notifies.
    expect(crons).toContain('0 1,13 * * *'); // recatalog-sweep, every 12h
    expect(crons).toContain('*/30 * * * *'); // tips-review-notify
  });
});

describe('scheduled work is fail-closed', () => {
  /**
   * Every runtime that is not the production Worker still talks to the *production* Supabase, so
   * a sweep running anywhere else writes real catalogue rows and the tips notifier sends real
   * notifications. Running one from staging or a laptop is not a dry run.
   */
  it('requires a variable that wrangler.jsonc deliberately does not set', () => {
    // Absent from `vars` is the point: it has to be set on the production Worker and nowhere
    // else. This is the gate that holds under `wrangler dev`, where URL is inherited from the
    // top-level vars and therefore does say production.
    expect(workerSource).toContain("process.env.SCHEDULED_JOBS_ENABLED !== 'true'");
    expect(JSON.stringify(wrangler.vars)).not.toContain('SCHEDULED_JOBS_ENABLED');
  });

  it('also checks the production URL, for a staging deploy handed the variable by accident', () => {
    // The same check stripe.ts and sentry.ts use, so the three gates can't disagree.
    expect(workerSource).toContain('isProductionSite()');
  });

  it('says which gate stopped it rather than skipping quietly', () => {
    // A job silently not running is the failure this phase exists to remove.
    expect(workerSource).toContain('skipping scheduled');
    expect(workerSource).toContain('is not the production Worker');
  });
});

describe('staging cannot run production work', () => {
  const staging = (wrangler.env as Record<string, Record<string, unknown>>).staging;

  it('fires no crons at all', () => {
    // Staging shares one production Supabase with the real site, so a sweep there writes real
    // catalogue rows and a tips notifier sends real notifications. Structural, not a runtime check.
    expect((staging.triggers as { crons: string[] }).crons).toEqual([]);
  });

  it('reads its own queue, not production’s', () => {
    const stagingQueues = staging.queues as { consumers: { queue: string }[] };
    expect(stagingQueues.consumers[0].queue).not.toBe(queues.consumers[0].queue);
  });

  it('is tagged as somewhere other than production', () => {
    // scheduled() also checks this at runtime, and Sentry tags its environment from it.
    expect((staging.vars as { URL: string }).URL).not.toBe('https://unstream.stream');
  });
});

describe('parseBackgroundMessage', () => {
  it('reads a message the producer wrote', () => {
    expect(parseBackgroundMessage({ functionName: 'catalog-artist-background', body: '{"artistIds":["a"]}' })).toEqual({
      functionName: 'catalog-artist-background',
      body: '{"artistIds":["a"]}',
    });
  });

  const refused: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'a string'],
    ['a missing body', { functionName: 'x' }],
    ['a missing name', { body: '{}' }],
    ['a non-string name', { functionName: 1, body: '{}' }],
    ['a non-string body', { functionName: 'x', body: { not: 'a string' } }],
  ];

  it.each(refused)('refuses %s', (_label, raw) => {
    expect(parseBackgroundMessage(raw)).toBeNull();
  });

  it('is what stops a message from an older deploy retrying forever', () => {
    // An unreadable message is acked and logged rather than retried into the dead-letter queue,
    // because no number of retries will make it readable.
    expect(workerSource).toContain('dropping an unreadable queue message');
    expect(workerSource).toContain('message.ack()');
  });
});

describe('no deploy can take over the production domain by accident', () => {
  /**
   * A route claims live traffic on deploy, and `routes` is *inherited* by every named environment.
   * With unstream.stream at the top level, the first `wrangler deploy` was the cutover, and
   * `wrangler deploy --env staging` would have reassigned the production domain to the staging
   * Worker. Wrangler says so — "Deploying this environment will reassign these custom domains
   * away from the top-level Worker" — but only as a warning.
   *
   * So the production hostname appears nowhere until a reviewed cutover change adds it.
   *
   * Every form of routing counts, not just custom domains: wrangler also takes a singular `route`
   * key, plain-string routes, and zone routes (`pattern` + `zone_name`) on the existing proxied
   * hostname — each sends production traffic to the Worker just as surely. A guard that checked
   * only `custom_domain: true` objects let all of those through.
   */
  const PRODUCTION_HOSTS = ['unstream.stream', 'www.unstream.stream'];
  type RouteEntry = string | { pattern?: string; custom_domain?: boolean; zone_name?: string };

  /** Every route a config declares, whichever key or shape it used. */
  const routeEntries = (config: Record<string, unknown>): RouteEntry[] => {
    const entries: RouteEntry[] = [];
    if (config.route !== undefined) entries.push(config.route as RouteEntry);
    for (const entry of (config.routes ?? []) as RouteEntry[]) entries.push(entry);
    return entries;
  };

  /**
   * The hostname a route pattern matches: `*unstream.stream/*` and `*.unstream.stream/*` count too.
   * A pattern with no hostname of its own (a bare wildcard) matches everything in its zone, so the
   * zone is the hostname it claims.
   */
  const hostOf = (entry: RouteEntry): string => {
    const pattern = typeof entry === 'string' ? entry : (entry.pattern ?? '');
    const host = pattern.replace(/^\*\.?/, '').split('/')[0];
    if (host === '' && typeof entry !== 'string' && entry.zone_name) return entry.zone_name;
    return host;
  };

  const claimsProduction = (config: Record<string, unknown>) =>
    routeEntries(config).map(hostOf).filter((host) => PRODUCTION_HOSTS.includes(host));

  it('claims nothing at the top level, so a plain deploy lands on workers.dev', () => {
    expect(routeEntries(wrangler)).toEqual([]);
  });

  it('gives every named environment its own routes, so none inherits one it should not have', () => {
    for (const [name, env] of Object.entries(wrangler.env as Record<string, Record<string, unknown>>)) {
      expect(env.routes ?? env.route, `env.${name} must declare its routes`).toBeDefined();
    }
  });

  it('never points a named environment at the production hostname, in any route form', () => {
    for (const [name, env] of Object.entries(wrangler.env as Record<string, Record<string, unknown>>)) {
      expect(claimsProduction(env), `env.${name}`).toEqual([]);
    }
  });

  it('puts staging on its own hostname on the zone, where caching and purge can be tested', () => {
    const staging = (wrangler.env as Record<string, Record<string, unknown>>).staging;
    expect(routeEntries(staging)).toEqual([{ pattern: 'next.unstream.stream', custom_domain: true }]);
  });

  describe('the guard itself recognises every way of routing production', () => {
    // Checked against hand-built configs, so a future edit to hostOf/routeEntries can't quietly
    // weaken the assertions above.
    it.each([
      ['a custom domain', { routes: [{ pattern: 'unstream.stream', custom_domain: true }] }],
      ['a zone route', { routes: [{ pattern: 'unstream.stream/*', zone_name: 'unstream.stream' }] }],
      ['a string route', { routes: ['unstream.stream/*'] }],
      ['a leading-wildcard route', { routes: ['*unstream.stream/*'] }],
      ['a subdomain wildcard', { routes: ['*.unstream.stream/*'] }],
      ['a zone-wide catch-all', { routes: [{ pattern: '*/*', zone_name: 'unstream.stream' }] }],
      ['the singular `route` key', { route: 'unstream.stream/*' }],
      ['www', { routes: [{ pattern: 'www.unstream.stream', custom_domain: true }] }],
    ])('flags %s', (_label, config) => {
      expect(claimsProduction(config as Record<string, unknown>)).not.toEqual([]);
    });

    it('does not flag the staging hostname', () => {
      expect(claimsProduction({ routes: [{ pattern: 'next.unstream.stream', custom_domain: true }] })).toEqual([]);
      expect(claimsProduction({ routes: [{ pattern: 'next.unstream.stream/*', zone_name: 'unstream.stream' }] })).toEqual([]);
    });
  });
});
