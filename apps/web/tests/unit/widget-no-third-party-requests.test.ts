// The embed widget runs on other people's websites, where our own CSP in netlify.toml does not
// apply — the host page's policy governs. So anything widget.js fetches is a third-party request
// we've added to a partner's page with nothing protecting it.
//
// It used to @import a Coollabs font stylesheet into its shadow root, which fetched on every
// embed and applied nothing: font faces declared inside a shadow root are never registered with
// the document's font set. That's the kind of thing a future change re-adds for good-looking
// reasons, so the invariant is pinned here rather than left to review.
//
// Asserted against the shipped file as text, because widget.js is a plain IIFE served straight
// from public/ — there is no module to import and nothing to mock.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WIDGET_PATH = fileURLToPath(new URL('../../public/widget.js', import.meta.url));
const raw = readFileSync(WIDGET_PATH, 'utf8');

/**
 * The file's code, without its full-line `//` comments.
 *
 * Needed because the comment explaining *why* there is no font import necessarily contains the
 * word `@import`, and a comment is not a request. Only whole-line comments are dropped — a
 * naive strip of everything after `//` would eat the `https://` in every real URL.
 */
const widget = raw
  .split('\n')
  .filter(line => !line.trimStart().startsWith('//'))
  .join('\n');

/** Every absolute http(s) URL the file contains, wherever it appears. */
function urlsIn(source: string): string[] {
  return source.match(/https?:\/\/[^"' )]+/g) ?? [];
}

describe('widget.js — no third-party requests', () => {
  it('points every absolute URL at our own origin', () => {
    const foreign = urlsIn(widget).filter(url => !url.startsWith('https://unstream.stream'));
    expect(foreign).toEqual([]);
  });

  // The specific regression: a stylesheet pulled into the shadow root. `@import` is the only
  // way CSS itself can start a request, so its absence is what makes the rule above complete
  // for the style block.
  it('imports no stylesheet into the shadow root', () => {
    expect(widget).not.toContain('@import');
  });

  // Guards the reason the URL rule is worth anything: if the widget stopped talking to our own
  // API, this file would pass vacuously.
  it('still calls our API, so the rule above is not vacuous', () => {
    expect(urlsIn(widget)).toContain('https://unstream.stream');
    expect(widget).toContain('/api/artist?slug=');
  });
});
