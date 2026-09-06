// Guards the invariant behind #512 (the Coollabs font @import that never applied but still
// made every embed fetch from a third party): widget.js runs on partner sites, outside our CSP,
// so every http(s) URL it contains must point at our own origin.
//
// Asserted against the shipped file as text, because widget.js is a plain IIFE served straight
// from public/ — there is no module to import and nothing to mock.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const widgetPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../public/widget.js'
);
const raw = readFileSync(widgetPath, 'utf-8');

/**
 * The file's code, without its full-line `//` comments.
 *
 * A comment is not a request, and widget.js carries one explaining *why* there is no font
 * import — which necessarily contains the word `@import`, and could easily come to quote the
 * Coollabs URL it is about. Without this, documenting the fix would break the test guarding it.
 *
 * Only whole-line comments are dropped: stripping everything after `//` would eat the `https://`
 * in every real URL.
 */
const widgetSource = raw
  .split('\n')
  .filter(line => !line.trimStart().startsWith('//'))
  .join('\n');

describe('widget.js makes no third-party requests', () => {
  it('every http(s) URL in the file points at unstream.stream', () => {
    const urls = widgetSource.match(/https?:\/\/[^\s"'()]+/g) || [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).hostname).toBe('unstream.stream');
    }
  });

  // The specific regression, and the gap the URL rule alone leaves: CSS can start a request of
  // its own, and a protocol-relative or relative `@import` carries no `https://` for the check
  // above to catch.
  it('imports no stylesheet into the shadow root', () => {
    expect(widgetSource).not.toContain('@import');
  });
});
