/**
 * Try Mirlo release ingest against the real API, locally, without writing anything.
 *
 * Usage:
 *   npx tsx scripts/ingest-mirlo.ts <mirlo-url-or-slug>
 *   npx tsx scripts/ingest-mirlo.ts timerival
 *   npx tsx scripts/ingest-mirlo.ts https://mirlo.space/timerival/releases
 *   npx tsx scripts/ingest-mirlo.ts timerival --json
 *   npx tsx scripts/ingest-mirlo.ts timerival --raw     (field-level audit of the response)
 *
 * Exercises the real path — the same slug derivation, the same parse, the same mapping to
 * release rows production uses — and prints what *would* be written.
 *
 * **One request, whole discography, prices included.** Unlike the Bandcamp script there is no
 * `--detail` flag, because there is no detail pass: `/v1/artists/{slug}` returns every release
 * and its price in the same response. This is the cheapest source in the codebase.
 *
 * DRY RUN ONLY, DELIBERATELY. There is no --write flag, for the same reason
 * scripts/ingest-releases.ts has none: .env points at the production Supabase, so a local write
 * path would mean a laptop writing real `releases` rows. Everything with a decision in it is
 * upstream of the database anyway, and `persistMirloReleases` is covered by unit tests.
 *
 * `--raw` exists because this endpoint has three fields that are easy to read wrongly:
 * `minPrice` is in cents, `null` there is *not* zero, and `platformPercent` looks like a payout
 * share but is not trustworthy as one. It prints them unmapped so a surprise is visible rather
 * than absorbed silently by the mapping.
 *
 * Mirlo granted Unstream permission to use this endpoint (2026-08-05). Still one request per
 * run — be a good neighbour and don't loop it.
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const { ingestMirloArtist, mirloArtistSlug } = await import('../api/functions/release-ingest.js');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const showRaw = args.includes('--raw');
const target = args.find(a => !a.startsWith('--'));

if (!target) {
  console.error('Usage: npx tsx scripts/ingest-mirlo.ts <mirlo-url-or-slug> [--json] [--raw]');
  process.exit(1);
}

// A bare word is treated as a Mirlo artist slug, which is how most artists are stored.
const storedUrl = target.includes('://') ? target : `https://mirlo.space/${target}`;

// The same derivation production applies, so a URL this rejects fails here too rather than
// being quietly normalized into something that happens to work.
const slug = mirloArtistSlug(storedUrl);
if (!slug) {
  console.error(`Could not derive a Mirlo artist slug from ${storedUrl}`);
  console.error('Refused for one of three reasons, all deliberate: the host is not mirlo.space,');
  console.error('there is no first path segment, or the segment is one of Mirlo’s own routes');
  console.error('(/login, /pages, /admin, …) which sit at the same depth as artist profiles.');
  process.exit(1);
}

const apiUrl = `https://api.mirlo.space/v1/artists/${encodeURIComponent(slug)}`;
const headers: Record<string, string> = {
  'User-Agent': 'Unstream/1.0 (https://unstream.stream - ethical music finder)',
};
// Sent when present, exactly as production does. Verified 2026-08-05: this endpoint answers
// identically without it, so an absent key is not a failure — it just isn't attributed to us.
if (process.env.MIRLO_API_KEY) headers['mirlo-api-key'] = process.env.MIRLO_API_KEY;

if (!asJson) {
  console.log(`\nFetching ${apiUrl} …`);
  if (!process.env.MIRLO_API_KEY) console.log('(no MIRLO_API_KEY set — sending unauthenticated)');
}

const response = await globalThis.fetch(apiUrl, { headers });
if (!response.ok) {
  console.error(`Mirlo responded ${response.status}.`);
  process.exit(1);
}

let body: unknown;
try {
  body = await response.json();
} catch {
  console.error('Mirlo returned a 200 with a non-JSON body — a challenge or error page.');
  process.exit(2);
}

const releases = ingestMirloArtist(body, slug);

// The distinction production depends on: null means the response wasn't an artist document at
// all, which must never be recorded as "this artist has released nothing".
if (releases === null) {
  console.error('\nThe 200 was not a Mirlo artist document for this slug.');
  console.error('Not an empty discography — the parse refused it, so nothing would be written.');
  process.exit(2);
}

const raw = (body as { result?: { trackGroups?: unknown[] } }).result?.trackGroups ?? [];

if (asJson) {
  console.log(JSON.stringify({ apiUrl, slug, upstreamCount: raw.length, releases }, null, 2));
  process.exit(0);
}

console.log(`\nWould write ${releases.length} release(s). Nothing was saved.`);
console.log(`Mirlo returned ${raw.length} trackGroup(s); ${raw.length - releases.length} skipped ` +
  '(drafts, hidden, or deleted).\n');

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 2) + '… ' : s.padEnd(n));
console.log(pad('TYPE', 12) + pad('TITLE', 38) + pad('DATE', 12) + pad('STATUS', 11) + pad('PRICE', 12) + 'ART');
console.log('-'.repeat(96));
for (const r of releases) {
  const offer = r.offers[0];
  const price = !offer
    ? 'no offer'
    : offer.price === 0
      ? 'name-your-price'
      : `${offer.price} ${offer.currency ?? '?'}`;
  console.log(
    pad(r.releaseType, 12) +
      pad(r.title, 38) +
      pad(r.releaseDate ?? 'none', 12) +
      pad(r.status, 11) +
      pad(price, 12) +
      (r.artworkUrl ? 'yes' : 'NO')
  );
}

// Surfaced as counts because these are the things most likely to be quietly wrong, and
// "no offer" versus "free" is the distinction with the most product consequence.
const noOffer = releases.filter(r => r.offers.length === 0).length;
const nyp = releases.filter(r => r.offers[0]?.price === 0).length;
const undated = releases.filter(r => !r.releaseDate).length;
const announced = releases.filter(r => r.status === 'announced').length;
console.log(
  `\nsummary: ${releases.length} releases · ${noOffer} with no offer · ${nyp} name-your-price · ` +
    `${undated} undated · ${announced} announced`
);
console.log('note: "no offer" means Mirlo has no price configured. It is NOT free — publishing');
console.log('      it as 0 would render "Name your price" and misstate the artist’s terms.\n');

if (showRaw) {
  console.log('Raw upstream fields, unmapped — the three that are easy to misread:\n');
  console.log(pad('TITLE', 38) + pad('minPrice', 10) + pad('currency', 10) + pad('type', 8) + 'platformPercent');
  console.log('-'.repeat(88));
  for (const node of raw as Array<Record<string, unknown>>) {
    console.log(
      pad(String(node.title ?? '(untitled)'), 38) +
        pad(node.minPrice === null ? 'null' : String(node.minPrice), 10) +
        pad(String(node.currency ?? '—'), 10) +
        pad(String(node.type ?? 'null'), 8) +
        String(node.platformPercent ?? '—')
    );
  }
  console.log('\nminPrice is in CENTS (400 = 4.00), and null is "no price set", not zero.');
  console.log('platformPercent is printed for visibility only — the ingest deliberately ignores it,');
  console.log('since it contradicts defaultPlatformFee and reached 100 on a free release.\n');
}
