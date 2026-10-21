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
    expect(workerSource).toContain('PRODUCTION_SITE_URL');
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
