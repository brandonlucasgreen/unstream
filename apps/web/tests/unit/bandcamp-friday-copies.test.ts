// Every copy of the Bandcamp Friday dates must match the web app's, which is the source of truth.
//
// Each runtime keeps its own copy (the extension ships plain JS, the Mac app is Swift, edge
// functions can't import from apps/web), and `npm run sync:bandcamp-dates` regenerates them. This
// exists because the Mac copy was once edited by hand and missed: it treated every first Friday
// of 2026 as a Bandcamp Friday, highlighting 100%-payout platforms on days that weren't.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(__dirname, '../../../..');

/** The dates in the `[...]` literal assigned to `marker` in a file. */
function datesIn(relativePath: string, marker: string): string[] {
  const source = readFileSync(resolve(repo, relativePath), 'utf-8');
  const start = source.indexOf(marker);
  expect(start, `${marker} not found in ${relativePath}`).toBeGreaterThanOrEqual(0);
  // After the `=`, so a type annotation like `string[]` isn't mistaken for the literal.
  const open = source.indexOf('[', source.indexOf('=', start));
  const close = source.indexOf(']', open);
  return source.slice(open, close).match(/\d{4}-\d{2}-\d{2}/g) ?? [];
}

const webDates = datesIn('apps/web/src/utils/bandcamp-friday.ts', 'const BANDCAMP_FRIDAY_DATES');

describe('Bandcamp Friday date copies', () => {
  it('reads a non-empty source of truth', () => {
    expect(webDates.length).toBeGreaterThan(0);
  });

  it.each([
    ['browser extension', 'apps/extension/lib/bandcamp-friday.js', 'const BANDCAMP_FRIDAY_DATES'],
    ['Mac app', 'apps/mac/Unstream/BandcampFriday.swift', 'private let bandcampFridayDates'],
    ['server and edge functions', 'api/shared/bandcamp-friday.ts', 'export const BANDCAMP_FRIDAY_DATES'],
  ])('the %s copy matches the web app (run `npm run sync:bandcamp-dates`)', (_name, path, marker) => {
    expect(datesIn(path, marker)).toEqual(webDates);
  });
});
