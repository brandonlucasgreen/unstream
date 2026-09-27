// API endpoint: /api/artist-interest — "I'd tip them" and Play my city
// (docs/specs/artist-patronage-spec.md §3.5, §3.6). No money is involved anywhere here.
//
// All requests need a signed-in fan (Bearer token).
//   GET                              the fan's own taps: { tip: slug[], cities: { slug: label }, defaultCity }
//   GET ?suggest=<text>              city suggestions for the Play my city input
//   GET ?slug=<slug>&view=dashboard  the artist's full counts, for the owner of a verified claim only
//   POST   { slug, kind: 'tip' }                 record "I'd tip them" (idempotent)
//   POST   { slug, kind: 'city', city: string }  record or change the fan's city for this artist
//   DELETE { slug, kind }                        take it back
//
// Public counts (threshold of three) are not served here: they ride on the artist page payload
// and the search results, so a result card doesn't cost a request of its own.

import { getClient, resolveOwnedArtist } from './db';
import { checkRateLimit, getClientIp, resolveAccountRequest } from './ratelimit';
import { DASHBOARD_COUNTS, getArtistInterestCounts, getCitySuggestions } from './interest-counts';
import { Sentry } from '../lib/sentry';
import { cityKey, cleanCityLabel } from '../shared/artist-interest';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

type Kind = 'tip' | 'city';
const TABLE: Record<Kind, 'tip_interest' | 'city_interest'> = { tip: 'tip_interest', city: 'city_interest' };

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
  queryStringParameters?: Record<string, string | undefined> | null;
}

function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

export async function handler(event: HandlerEvent) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  const { key, user } = await resolveAccountRequest(event.headers.authorization, ip);
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response;

  if (!user) return respond(401, { error: 'Sign in to tell artists where you are' });

  const client = getClient();
  if (!client) return respond(500, { error: 'Database not configured' });

  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters ?? {};

      if (typeof params.suggest === 'string') {
        const label = cleanCityLabel(params.suggest);
        if (!label || label.length < 2) return respond(200, { suggestions: [] });
        const suggestions = await getCitySuggestions(cityKey(label));
        if (suggestions === null) return respond(503, { error: 'Suggestions unavailable' });
        return respond(200, { suggestions });
      }

      if (params.view === 'dashboard') {
        const slug = params.slug ?? '';
        if (!SLUG_REGEX.test(slug)) return respond(400, { error: 'Invalid artist' });
        const owned = await resolveOwnedArtist(slug, user.userId);
        if (!owned.ok) return respond(owned.status, { error: owned.error });
        const counts = await getArtistInterestCounts([slug], DASHBOARD_COUNTS);
        if (counts === null) return respond(503, { error: 'Counts unavailable' });
        return respond(200, counts.get(slug) ?? { tipCount: 0, cities: [] });
      }

      return await getOwnTaps(client, user.userId);
    }

    if (event.httpMethod === 'POST' || event.httpMethod === 'DELETE') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return respond(400, { error: 'Invalid JSON' });
      }

      const slug = typeof body.slug === 'string' ? body.slug : '';
      const kind = body.kind === 'tip' || body.kind === 'city' ? body.kind : null;
      if (!SLUG_REGEX.test(slug)) return respond(400, { error: 'Invalid artist' });
      if (!kind) return respond(400, { error: "kind must be 'tip' or 'city'" });

      let city: string | null = null;
      if (event.httpMethod === 'POST' && kind === 'city') {
        city = cleanCityLabel(body.city);
        if (!city) return respond(400, { error: 'Enter a city (up to 100 characters)' });
      }

      // Exact slug only: an alias or a guessed slug must not create interest on a row nobody
      // links to. Search results and artist pages both carry the canonical slug.
      const { data: artist, error: findError } = await client
        .from('artists').select('id').eq('slug', slug).maybeSingle();
      if (findError) {
        console.error('[artist-interest] artist lookup failed:', findError.message);
        return respond(503, { error: 'Try again in a moment' });
      }
      if (!artist) return respond(404, { error: 'Artist not found' });
      const artistId = (artist as { id: string }).id;

      if (event.httpMethod === 'DELETE') {
        const { error } = await client.from(TABLE[kind]).delete()
          .eq('artist_id', artistId).eq('user_id', user.userId);
        if (error) return writeFailed('delete', kind, error.message);
        return respond(200, { slug, kind, active: false });
      }

      if (kind === 'tip') {
        const { error } = await client.from('tip_interest').upsert(
          { artist_id: artistId, user_id: user.userId },
          { onConflict: 'artist_id,user_id', ignoreDuplicates: true },
        );
        if (error) return writeFailed('upsert', kind, error.message);
        return respond(200, { slug, kind, active: true });
      }

      const { error } = await client.from('city_interest').upsert(
        { artist_id: artistId, user_id: user.userId, city_key: cityKey(city!), city_label: city },
        { onConflict: 'artist_id,user_id' },
      );
      if (error) return writeFailed('upsert', kind, error.message);
      return respond(200, { slug, kind, active: true, city });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (error) {
    Sentry.captureException(error, { extra: { context: 'artist-interest.handler' } });
    return respond(500, { error: 'Internal server error' });
  }
}

function writeFailed(op: string, kind: Kind, message: string) {
  Sentry.captureMessage('[artist-interest] write failed', {
    level: 'error',
    extra: { context: `artist-interest.${op}`, kind, error: message },
  });
  return respond(500, { error: 'Could not save that — try again' });
}

/** Which artists this fan has tapped, keyed by slug, plus their profile location for the input. */
async function getOwnTaps(client: NonNullable<ReturnType<typeof getClient>>, userId: string) {
  const [tips, cities, location] = await Promise.all([
    client.from('tip_interest').select('artist_id').eq('user_id', userId),
    client.from('city_interest').select('artist_id, city_label').eq('user_id', userId),
    client.from('usernames').select('location').eq('user_id', userId).maybeSingle(),
  ]);
  const failed = tips.error || cities.error;
  if (failed) {
    console.error('[artist-interest] own taps read failed:', failed.message);
    return respond(503, { error: 'Try again in a moment' });
  }

  const tipRows = (tips.data ?? []) as Array<{ artist_id: string }>;
  const cityRows = (cities.data ?? []) as Array<{ artist_id: string; city_label: string }>;
  const ids = [...new Set([...tipRows, ...cityRows].map(r => r.artist_id))];

  const slugById = new Map<string, string>();
  if (ids.length > 0) {
    const { data, error } = await client.from('artists').select('id, slug').in('id', ids);
    if (error) {
      console.error('[artist-interest] slug read failed:', error.message);
      return respond(503, { error: 'Try again in a moment' });
    }
    for (const row of (data ?? []) as Array<{ id: string; slug: string }>) slugById.set(row.id, row.slug);
  }

  const tip = tipRows.map(r => slugById.get(r.artist_id)).filter((s): s is string => !!s);
  const cityBySlug: Record<string, string> = {};
  for (const r of cityRows) {
    const slug = slugById.get(r.artist_id);
    if (slug) cityBySlug[slug] = r.city_label;
  }
  const defaultCity = (location.data as { location?: string | null } | null)?.location ?? null;

  return respond(200, { tip, cities: cityBySlug, defaultCity });
}
