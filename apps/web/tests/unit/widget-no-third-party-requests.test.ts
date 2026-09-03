// Guards the invariant behind #512 (the Coollabs font @import that never applied but still
// made every embed fetch from a third party): widget.js runs on partner sites, outside our CSP,
// so every http(s) URL it contains must point at our own origin.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const widgetPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../public/widget.js'
);
const widgetSource = readFileSync(widgetPath, 'utf-8');

describe('widget.js makes no third-party requests', () => {
  it('every http(s) URL in the file points at unstream.stream', () => {
    const urls = widgetSource.match(/https?:\/\/[^\s"'()]+/g) || [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).hostname).toBe('unstream.stream');
    }
  });
});
