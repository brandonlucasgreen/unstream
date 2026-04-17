/**
 * Sync Bandcamp Friday dates from the web app to the browser extension.
 *
 * The web app (apps/web/src/utils/bandcamp-friday.ts) is the source of truth.
 * Run this script once a year when Bandcamp announces new Friday dates:
 *
 *   npm run sync:bandcamp-dates
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const webSource = join(root, 'apps/web/src/utils/bandcamp-friday.ts');
const extDest = join(root, 'apps/extension/lib/bandcamp-friday.js');

const webContent = readFileSync(webSource, 'utf-8');

// Extract the dates array from the web TS file
const match = webContent.match(/const BANDCAMP_FRIDAY_DATES\s*=\s*(\[[\s\S]*?\]);/);
if (!match) {
  console.error('Could not find BANDCAMP_FRIDAY_DATES in', webSource);
  process.exit(1);
}

const datesArray = match[1];

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

writeFileSync(extDest, extContent, 'utf-8');
console.log(`Synced Bandcamp Friday dates from web app to extension.`);
console.log(`Dates array written to: apps/extension/lib/bandcamp-friday.js`);
