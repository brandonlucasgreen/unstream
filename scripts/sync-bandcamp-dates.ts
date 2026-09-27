/**
 * Sync Bandcamp Friday dates from the web app to every other copy.
 *
 * The web app (apps/web/src/utils/bandcamp-friday.ts) is the source of truth. It is copied to:
 *   - apps/extension/lib/bandcamp-friday.js      (browser extension)
 *   - apps/mac/Unstream/BandcampFriday.swift     (Mac app)
 *   - api/shared/bandcamp-friday.ts              (server + edge functions)
 *
 * Each runtime needs its own copy: the extension ships as plain JS, the Mac app is Swift, and
 * edge functions can't import from apps/web. Run this once a year when Bandcamp announces new
 * Friday dates:
 *
 *   npm run sync:bandcamp-dates
 *
 * The Mac copy used to be edited by hand, and a date fix (9bfb7a0) landed on its old path
 * (apps/mac/UnstreamMenubar/) instead, leaving the Mac app on "every first Friday" for months.
 * apps/web/tests/unit/bandcamp-friday-copies.test.ts fails if any copy drifts.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const webSource = join(root, 'apps/web/src/utils/bandcamp-friday.ts');
const extDest = join(root, 'apps/extension/lib/bandcamp-friday.js');
const macDest = join(root, 'apps/mac/Unstream/BandcampFriday.swift');
const sharedDest = join(root, 'api/shared/bandcamp-friday.ts');

const webContent = readFileSync(webSource, 'utf-8');

// Extract the dates array from the web TS file
const match = webContent.match(/const BANDCAMP_FRIDAY_DATES\s*=\s*(\[[\s\S]*?\]);/);
if (!match) {
  console.error('Could not find BANDCAMP_FRIDAY_DATES in', webSource);
  process.exit(1);
}

const datesArray = match[1];
const dates = datesArray.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
if (dates.length === 0) {
  console.error('BANDCAMP_FRIDAY_DATES in', webSource, 'has no dates');
  process.exit(1);
}

// Reconstruct the extension file with the extracted dates
const extContent = `// UPDATE ANNUALLY: Bandcamp Friday dates from https://daily.bandcamp.com/features/bandcamp-fridays
// Dates run midnight-to-midnight Pacific time
// SOURCE OF TRUTH: apps/web/src/utils/bandcamp-friday.ts — run \`npm run sync:bandcamp-dates\` to sync
const BANDCAMP_FRIDAY_DATES = ${datesArray};

export function isBandcampFriday(now) {
  const d = now || new Date();
  // en-CA locale gives YYYY-MM-DD format; timezone ensures Pacific time check
  const pacificDate = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return BANDCAMP_FRIDAY_DATES.includes(pacificDate);
}
`;

// The Mac app: the same dates as a Swift Set, grouped under a comment per year, four to a line.
const swiftLines: string[] = [];
for (const year of [...new Set(dates.map((d) => d.slice(0, 4)))]) {
  swiftLines.push(`    // ${year}`);
  const yearDates = dates.filter((d) => d.startsWith(year)).map((d) => `"${d}"`);
  for (let i = 0; i < yearDates.length; i += 4) {
    swiftLines.push(`    ${yearDates.slice(i, i + 4).join(', ')},`);
  }
}

const macContent = `import Foundation

// UPDATE ANNUALLY: Bandcamp Friday dates from https://daily.bandcamp.com/features/bandcamp-fridays
// Dates run midnight-to-midnight Pacific time
// SOURCE OF TRUTH: apps/web/src/utils/bandcamp-friday.ts — run \`npm run sync:bandcamp-dates\` to sync
private let bandcampFridayDates: Set<String> = [
${swiftLines.join('\n')}
]

func isBandcampFriday(now: Date = Date()) -> Bool {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.timeZone = TimeZone(identifier: "America/Los_Angeles")
    let pacificDate = formatter.string(from: now)
    return bandcampFridayDates.contains(pacificDate)
}
`;

// Server + edge functions: the web array without its year comments.
const sharedContent = `// Bandcamp Friday dates — shared between the edge function and API endpoints.
// UPDATE ANNUALLY: Bandcamp Friday dates from https://daily.bandcamp.com/features/bandcamp-fridays

export const BANDCAMP_FRIDAY_DATES: string[] = ${datesArray.replace(/^[ \t]*\/\/.*\n/gm, '')};

export function isBandcampFriday(): boolean {
  const pacificDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return BANDCAMP_FRIDAY_DATES.includes(pacificDate);
}`;

writeFileSync(extDest, extContent, 'utf-8');
writeFileSync(macDest, macContent, 'utf-8');
writeFileSync(sharedDest, sharedContent, 'utf-8');
console.log(`Synced ${dates.length} Bandcamp Friday dates from the web app to:`);
console.log('  apps/extension/lib/bandcamp-friday.js');
console.log('  apps/mac/Unstream/BandcampFriday.swift');
console.log('  api/shared/bandcamp-friday.ts');
