// API endpoint: GET/POST /api/admin/artist-duplicates
// Admin-only. Lists duplicate artist rows with the evidence for merging them, and performs a merge
// or a slug re-slug on request. Surfaced on /admin/verify (the Artist Review page).
//
// The merge logic itself lives in artist-merge.ts so this endpoint and
// scripts/merge-duplicate-artists.ts cannot drift apart — a merge is destructive across six tables
// and having two implementations of it would be asking for one of them to be wrong.

import { getClient } from './db';
import {
  findDuplicateArtistPairs,
  findReslugCandidates,
  mergeArtistPair,
  reslugArtist,
} from './artist-merge';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { Sentry } from '../lib/sentry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string;
}) {
  const origin = event.headers['origin'] || event.headers['Origin'];
  const CORS_HEADERS = buildCorsHeaders(origin, false);
  const json = (statusCode: number, payload: unknown) => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload),
  });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const admin = await authenticateAdmin(
    event.headers['authorization'] || event.headers['Authorization'] || undefined,
  );
  if (!admin) return json(401, { error: 'Unauthorized' });

  const client = getClient();
  if (!client) return json(500, { error: 'Database not configured' });

  // GET: the review list — every pair, its evidence, and anything blocking a merge.
  if (event.httpMethod === 'GET') {
    const [pairs, reslugs] = await Promise.all([
      findDuplicateArtistPairs(client),
      findReslugCandidates(client),
    ]);
    if (!pairs.ok) return json(503, { error: pairs.reason });
    if (!reslugs.ok) return json(503, { error: reslugs.reason });

    return json(200, {
      pairs: pairs.pairs,
      reslugCandidates: reslugs.candidates,
      // Surfaced so the page can say *why* the list is shorter than it looks: these are slugs an
      // artist chose, and re-slugging them would break URLs they share.
      reslugSkippedChosen: reslugs.skippedChosen,
    });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body: { action?: string; winnerId?: string; loserId?: string; artistId?: string; dryRun?: boolean; force?: boolean };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  // Default to a dry run. An admin has to ask for the write explicitly — this deletes artist rows.
  const dryRun = body.dryRun !== false;

  if (body.action === 'merge') {
    const { winnerId, loserId } = body;
    if (!winnerId || !loserId || !UUID_REGEX.test(winnerId) || !UUID_REGEX.test(loserId)) {
      return json(400, { error: 'winnerId and loserId must be artist UUIDs' });
    }
    if (winnerId === loserId) return json(400, { error: 'winnerId and loserId are the same row' });

    // Re-derive the pair server-side rather than trusting the client's idea of the evidence. The
    // page's list may be stale, and evidence is the whole safety mechanism.
    const pairs = await findDuplicateArtistPairs(client);
    if (!pairs.ok) return json(503, { error: pairs.reason });

    const pair = pairs.pairs.find(
      p => (p.winner.id === winnerId && p.loser.id === loserId)
        || (p.winner.id === loserId && p.loser.id === winnerId),
    );
    if (!pair) {
      return json(409, {
        error: 'Those two rows are not a current duplicate pair — the list may be stale. Reload and try again.',
      });
    }
    // Honour the admin's choice of direction if they inverted it, but keep the evidence we derived.
    const oriented = pair.winner.id === winnerId
      ? pair
      : { ...pair, winner: pair.loser, loser: pair.winner };

    const result = await mergeArtistPair(client, oriented, { dryRun, force: body.force === true });

    if (!dryRun && result.ok) {
      // Worth a breadcrumb: this is irreversible and the evidence class is the thing to audit later.
      Sentry.captureMessage('[admin] merged duplicate artist rows', {
        level: 'info',
        tags: { area: 'artist-merge' },
        extra: {
          admin: admin.email,
          evidence: result.evidence,
          winner: result.winner.slug,
          loser: result.loser.slug,
          forced: body.force === true,
          steps: result.steps,
        },
      });
    }
    return json(result.ok ? 200 : 409, result);
  }

  if (body.action === 'reslug') {
    const { artistId } = body;
    if (!artistId || !UUID_REGEX.test(artistId)) {
      return json(400, { error: 'artistId must be an artist UUID' });
    }
    const candidates = await findReslugCandidates(client);
    if (!candidates.ok) return json(503, { error: candidates.reason });

    const candidate = candidates.candidates.find(c => c.id === artistId);
    if (!candidate) {
      return json(409, {
        error: 'That artist is not a re-slug candidate. Either its slug already matches, or an artist chose it by hand.',
      });
    }
    const result = await reslugArtist(client, candidate, { dryRun });
    return json(result.ok ? 200 : 409, result);
  }

  return json(400, { error: "action must be 'merge' or 'reslug'" });
}
