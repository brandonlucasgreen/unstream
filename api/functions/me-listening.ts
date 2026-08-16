// API endpoint: /api/me/listening
// POST — upload per-artist listening signals from a client (today: the Mac app's iCloud
//        Music Library import). Body: { source, signals: [{ artistName, playCount, lastPlayed? }] }
// GET  — the gap: artists you play a lot and have never supported, ranked.
//
// Support Loop Steps 2 and 5. This is what makes the library import more than a local
// curiosity — without it the Mac app reads a library and nothing downstream can use it.
//
// Nothing here is ever public. Listening is not support: an Apple Music play, and even an
// iTunes purchase, maps to `owned`/`listened`, never `purchased`, so none of it reaches the
// public collection page. It also deliberately does NOT touch saved_artists — saving is a
// deliberate act that subscribes you to release alerts, and a library scan choosing it for
// you would bury the alerts that matter. (Bandcamp auto-marks supported because a purchase
// *is* support; a play isn't.)

import { createClient } from '@supabase/supabase-js';
import { artistSlug, getClient, readAllPages } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { resolveArtistPages } from './collection-utils';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

const VALID_SOURCES = new Set(['apple_music', 'lastfm', 'mac_app']);

/** A library can be thousands of artists; upsert in batches PostgREST is happy with. */
const UPSERT_CHUNK = 500;

/** Ceiling on one upload. A real library is a few thousand artists at most. */
const MAX_SIGNALS = 10_000;

/** How many gap rows to return. The list is a shopping list, not a database dump. */
const GAP_LIMIT = 100;

interface IncomingSignal {
  artistName: string;
  playCount: number;
  lastPlayed?: string | null;
}

async function authenticateRequest(authHeader: string | undefined): Promise<{ userId: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const { data, error } = await createClient(url, anonKey).auth.getUser(authHeader.slice(7));
  if (error || !data.user) return null;
  return { userId: data.user.id };
}

/** Validate and normalise the uploaded batch. Returns null when the body is unusable. */
export function parseSignals(raw: unknown): IncomingSignal[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_SIGNALS) return null;

  // Collapse duplicates in the payload: a repeated artist in one batch is a Postgres error
  // ("cannot affect row a second time"), not a harmless overwrite.
  const byName = new Map<string, IncomingSignal>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const artistName = typeof record.artistName === 'string' ? record.artistName.trim() : '';
    if (!artistName || artistName.length > 300) continue;
    const playCount =
      typeof record.playCount === 'number' && Number.isFinite(record.playCount)
        ? Math.max(0, Math.floor(record.playCount))
        : 0;
    const lastPlayed = typeof record.lastPlayed === 'string' ? record.lastPlayed : null;

    const key = artistName.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { artistName, playCount, lastPlayed });
    } else {
      // Keep the larger count, but the *first* spelling — a later lowercase duplicate
      // shouldn't overwrite the properly-cased name the library actually shows.
      if (playCount > existing.playCount) existing.playCount = playCount;
      if (lastPlayed && (!existing.lastPlayed || lastPlayed > existing.lastPlayed)) {
        existing.lastPlayed = lastPlayed;
      }
    }
  }
  return [...byName.values()];
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const rl = await checkRateLimit(getClientIp(event.headers), 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const user = await authenticateRequest(event.headers.authorization);
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

    const source = typeof body.source === 'string' ? body.source : '';
    if (!VALID_SOURCES.has(source)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unknown source' }) };
    }

    const signals = parseSignals(body.signals);
    if (!signals) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'signals must be an array of at most 10000 entries' }) };
    }

    const syncedAt = new Date().toISOString();
    const rows = signals.map(s => ({
      user_id: user.userId,
      source,
      artist_name: s.artistName,
      play_count: s.playCount,
      last_played: s.lastPlayed,
      synced_at: syncedAt,
    }));

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const { error } = await client
        .from('listening_signals')
        .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'user_id,source,artist_name' });
      if (error) {
        console.error('[me-listening] upsert failed:', error.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to save listening data' }) };
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ stored: rows.length, syncedAt }),
    };
  }

  if (event.httpMethod === 'DELETE') {
    // Deleting the uploaded signals is the counterpart to the Mac app's "Forget imported
    // data" — the promise that turning this off actually removes it.
    const { error } = await client.from('listening_signals').delete().eq('user_id', user.userId);
    if (error) {
      console.error('[me-listening] delete failed:', error.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to delete listening data' }) };
    }
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ deleted: true }) };
  }

  if (event.httpMethod === 'GET') {
    const signalsRead = await readAllPages<{ artist_name: string; play_count: number; last_played: string | null }>(
      (from, to) =>
        client
          .from('listening_signals')
          .select('artist_name, play_count, last_played')
          .eq('user_id', user.userId)
          .order('play_count', { ascending: false })
          .range(from, to),
      'listening_signals'
    );
    if (!signalsRead.ok) {
      console.error('[me-listening] read failed:', signalsRead.reason);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to load listening data' }) };
    }

    // What counts as already supported: an artist you marked supported, or one you own a
    // release by. Both are compared on the derived slug, the same key the Bandcamp import
    // uses to decide who to mark — so the two halves can't disagree about who's covered.
    const savedRead = await readAllPages<{ artist_slug: string | null; supported: boolean }>(
      (from, to) =>
        client
          .from('saved_artists')
          .select('artist_slug, supported')
          .eq('user_id', user.userId)
          .eq('deleted', false)
          .range(from, to),
      'saved_artists (gap)'
    );
    const collectionRead = await readAllPages<{ artist_name: string }>(
      (from, to) =>
        client.from('collection_items').select('artist_name').eq('user_id', user.userId).range(from, to),
      'collection_items (gap)'
    );

    const covered = new Set<string>();
    if (savedRead.ok) {
      for (const row of savedRead.rows) {
        if (row.supported && row.artist_slug) covered.add(row.artist_slug);
      }
    }
    if (collectionRead.ok) {
      for (const row of collectionRead.rows) covered.add(artistSlug(row.artist_name));
    }

    // Merge sources: the same artist can arrive from Apple Music and the now-playing
    // monitor, and the gap should rank them by total plays, not show them twice.
    const totals = new Map<string, { artistName: string; playCount: number; lastPlayed: string | null }>();
    for (const row of signalsRead.rows) {
      const slug = artistSlug(row.artist_name);
      if (!slug || covered.has(slug)) continue;
      const existing = totals.get(slug);
      if (existing) {
        existing.playCount += row.play_count;
        if (row.last_played && (!existing.lastPlayed || row.last_played > existing.lastPlayed)) {
          existing.lastPlayed = row.last_played;
        }
      } else {
        totals.set(slug, {
          artistName: row.artist_name,
          playCount: row.play_count,
          lastPlayed: row.last_played,
        });
      }
    }

    const ranked = [...totals.values()].sort((a, b) => b.playCount - a.playCount).slice(0, GAP_LIMIT);
    const artistPages = await resolveArtistPages(ranked.map(r => r.artistName));

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        gap: ranked.map(r => ({
          artistName: r.artistName,
          playCount: r.playCount,
          lastPlayed: r.lastPlayed,
          artistUrl: artistPages.has(r.artistName) ? `/a/${artistPages.get(r.artistName)}` : null,
        })),
        totalArtists: signalsRead.rows.length,
      }),
    };
  }

  return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
}
