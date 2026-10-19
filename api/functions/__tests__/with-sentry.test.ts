import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An invocation can be torn down as soon as it has answered — on Lambda the process froze
 * outright — so a captured Sentry event is lost unless the handler waits for it to send.
 * `withSentry` does that wait, but only when the invocation actually captured something.
 */

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@sentry/cloudflare', () => mocks);

// Captures only go anywhere when a DSN is set, and withSentry only flushes then. The DSN stays
// set for the whole file: isSentryInitialized() reads the environment when it is called, not
// once at import, so clearing it here would quietly turn every flush assertion below into a
// test of the no-DSN path instead.
const savedDsn = process.env.SENTRY_DSN;
process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
afterAll(() => {
  if (savedDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = savedDsn;
});

const { Sentry, withSentry, isSentryInitialized } = await import('../../lib/sentry');

describe('withSentry', () => {
  beforeEach(() => {
    mocks.captureException.mockClear();
    mocks.captureMessage.mockClear();
    mocks.flush.mockClear();
  });

  it('reports itself configured when SENTRY_DSN is set', () => {
    expect(isSentryInitialized()).toBe(true);
  });

  it('does not flush when nothing was captured', async () => {
    const handler = withSentry(async (n: number) => ({ statusCode: 200, body: String(n) }));

    await expect(handler(7)).resolves.toEqual({ statusCode: 200, body: '7' });
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it('flushes before returning when the handler captured something', async () => {
    let flushedBeforeReturn = false;
    mocks.flush.mockImplementationOnce(async () => {
      flushedBeforeReturn = true;
      return true;
    });
    const handler = withSentry(async () => {
      Sentry.captureMessage('upstream returned nothing', { level: 'warning' });
      Sentry.captureException(new Error('handled, but worth knowing'));
      return { statusCode: 200 };
    });

    await handler();

    expect(flushedBeforeReturn).toBe(true);
    expect(mocks.flush).toHaveBeenCalledTimes(1);
    expect(mocks.flush).toHaveBeenCalledWith(2000);
    expect(mocks.captureMessage).toHaveBeenCalledWith('upstream returned nothing', { level: 'warning' });
  });

  it('does not flush again on the next invocation once the queue was flushed', async () => {
    const reports = withSentry(async () => {
      Sentry.captureMessage('one');
    });
    const quiet = withSentry(async () => 'ok');

    await reports();
    await quiet();

    expect(mocks.flush).toHaveBeenCalledTimes(1);
  });

  it('reports a thrown error, flushes it, and rethrows it', async () => {
    const boom = new Error('column does not exist');
    const handler = withSentry(async () => {
      throw boom;
    });

    await expect(handler()).rejects.toBe(boom);
    expect(mocks.captureException).toHaveBeenCalledWith(boom);
    expect(mocks.flush).toHaveBeenCalledTimes(1);
  });
});

describe('every function exports its handler through withSentry', () => {
  const functionsDir = join(__dirname, '..');
  const files = readdirSync(functionsDir).filter((name) => name.endsWith('.ts'));
  const exportsHandler = /export\s+(?:async\s+function|function|const|let|var)\s+handler\b|export\s*\{[^}]*\bhandler\b[^}]*\}/;

  const functionFiles = files.filter((name) => exportsHandler.test(readFileSync(join(functionsDir, name), 'utf8')));

  it('finds the function files', () => {
    expect(functionFiles.length).toBeGreaterThan(50);
  });

  it.each(functionFiles)('%s', (name) => {
    const source = readFileSync(join(functionsDir, name), 'utf8');
    expect(source).toMatch(/export const handler = withSentry\(/);
  });
});
