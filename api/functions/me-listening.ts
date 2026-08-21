// API endpoint: /api/me/listening
// POST   — imports streaming-side play counts from the Mac app's Apple Music library scan.
//          Body: { source: 'apple_music', signals: [{ artistName: string, playCount: number }] }
//          Upserts into listening_signals; feeds the private gap report.
// DELETE — removes all of the user's apple_music rows (the app's "remove my data" action).
//
// Only apple_music is accepted today because the Mac app is the only writer. The table's
// CHECK constraint also allows 'lastfm' and 'mac_app' — extend the POST validation and the
// DELETE filter together when a second source ships.

import { getClient, readAllPages } from './db';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
};

/** Rows per upsert batch — keeps each PostgREST request comfortably sized (matches bandcamp-sync). */
const UPSERT_CHUNK = 500;

/** More artists than any plausible personal library; bounds memory and abuse. */
const MAX_SIGNALS = 10_000;

const MAX_ARTIST_NAME_LENGTH = 500;

/** Postgres `integer` max — a play count beyond this is a client bug, not a big library. */
const MAX_PLAY_COUNT = 2_147_483_647;

interface Signal {
  artistName: string;
  playCount: number;
}

/**
 * Validate and normalize the signals array. Returns the clean list, or a string describing
 * the first problem. Malformed *types* reject the whole request (that's a client bug worth
 * surfacing), but entries whose trimmed name is empty are skipped — a blank artist field in
 * someone's library is a data-quality quirk that must not brick their sync forever.
 */
function parseSignals(raw: unknown): Signal[] | string {
  if (!Array.isArray(raw)) return 'signals must be an array';
  if (raw.length > MAX_SIGNALS) return `signals must have at most ${MAX_SIGNALS} entries`;

  const clean: Signal[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return 'each signal must be an object';
    const { artistName, playCount } = entry as Record<string, unknown>;
    if (typeof artistName !== 'string') return 'artistName must be a string';
    if (artistName.length > MAX_ARTIST_NAME_LENGTH) {
      return `artistName must be ${MAX_ARTIST_NAME_LENGTH} characters or fewer`;
    }
    if (typeof playCount !== 'number' || !Number.isInteger(playCount) || playCount < 0 || playCount > MAX_PLAY_COUNT) {
      return 'playCount must be a non-negative integer';
    }
    const name = artistName.trim();
    if (!name) continue;
    clean.push({ artistName: name, playCount });
  }
  return clean;
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  // One verification, not two: deriving the rate-limit bucket already checked the token
  // (see resolveAccountRequest), so the user it found is the user this handler uses.
  const { key, user } = await resolveAccountRequest(event.headers.authorization, ip);
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response;

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  if (event.httpMethod === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (body.source !== 'apple_music') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "source must be 'apple_music'" }) };
    }

    const parsed = parseSignals(body.signals);
    if (typeof parsed === 'string') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: parsed }) };
    }

    // Dedupe by artist name, keeping the highest count — a duplicate in one upsert batch is
    // a Postgres error ("cannot affect row a second time"), not a harmless overwrite.
    const byName = new Map<string, number>();
    for (const s of parsed) {
      const prev = byName.get(s.artistName);
      if (prev === undefined || s.playCount > prev) byName.set(s.artistName, s.playCount);
    }

    try {
      // Diff against what's already stored so a re-import of a library that gained 3 plays
      // writes 3 rows, not thousands — every rewritten row is a dirty page the Supabase
      // free tier's disk-IO budget pays for, even when the values are identical.
      // Paged read: a real library can exceed PostgREST's silent 1,000-row cap.
      const existing = await readAllPages<{ artist_name: string; play_count: number }>(
        (from, to) => client
          .from('listening_signals')
          .select('artist_name, play_count')
          .eq('user_id', user.userId)
          .eq('source', 'apple_music')
          .order('artist_name')
          .range(from, to),
        'listening_signals'
      );
      if (!existing.ok) {
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to read existing signals' }) };
      }

      const stored = new Map(existing.rows.map(r => [r.artist_name, r.play_count]));
      const syncedAt = new Date().toISOString();
      const rows = [...byName.entries()]
        .filter(([name, count]) => stored.get(name) !== count)
        .map(([name, count]) => ({
          user_id: user.userId,
          source: 'apple_music',
          artist_name: name,
          play_count: count,
          synced_at: syncedAt,
        }));

      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK);
        const { error } = await client
          .from('listening_signals')
          .upsert(chunk, { onConflict: 'user_id,source,artist_name' });
        if (error) {
          console.error('[me-listening] Upsert failed:', error.message);
          return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to save listening signals' }) };
        }
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          received: byName.size,
          written: rows.length,
          unchanged: byName.size - rows.length,
        }),
      };
    } catch (error) {
      console.error('[me-listening] POST error:', error);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  if (event.httpMethod === 'DELETE') {
    try {
      const { error } = await client
        .from('listening_signals')
        .delete()
        .eq('user_id', user.userId)
        .eq('source', 'apple_music');

      if (error) {
        console.error('[me-listening] Delete failed:', error.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to delete listening signals' }) };
      }

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ deleted: true }) };
    } catch (error) {
      console.error('[me-listening] DELETE error:', error);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
}
