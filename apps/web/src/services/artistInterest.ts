// Client for /api/artist-interest — "I'd tip them" and Play my city.
//
// The fan's own taps are loaded once per signed-in user and shared by every card on the page
// through a tiny store, so a search results page costs one request, not one per card.

import { useEffect, useSyncExternalStore } from 'react';
import * as Sentry from '@sentry/react';
import type { InterestCounts } from '../../../../api/shared/artist-interest';

export type { InterestCounts };

export interface MyInterest {
  tip: Set<string>;
  cities: Record<string, string>;
  /** The fan's profile location, used to pre-fill Play my city. */
  defaultCity: string | null;
}

let state: { userId: string | null; mine: MyInterest | null } = { userId: null, mine: null };
let inFlight: { userId: string; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();

function publish(next: typeof state) {
  state = next;
  listeners.forEach(l => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function authHeaders(token: string): HeadersInit {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function loadMine(userId: string, token: string): Promise<void> {
  if (state.userId === userId && state.mine) return;
  if (inFlight?.userId === userId) return inFlight.promise;
  const promise = fetch('/api/artist-interest', { headers: authHeaders(token) })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data: { tip: string[]; cities: Record<string, string>; defaultCity: string | null }) => {
      publish({ userId, mine: { tip: new Set(data.tip), cities: data.cities, defaultCity: data.defaultCity } });
    })
    .catch(err => {
      Sentry.captureException(err, { extra: { context: 'artistInterest.loadMine' } });
    })
    .finally(() => { inFlight = null; });
  inFlight = { userId, promise };
  return promise;
}

/** The signed-in fan's taps, or null while loading / signed out. */
export function useMyInterest(session: { access_token: string; user: { id: string } } | null): MyInterest | null {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  const userId = session?.user.id ?? null;
  const token = session?.access_token ?? null;
  useEffect(() => {
    if (userId && token) void loadMine(userId, token);
  }, [userId, token]);
  return userId && snapshot.userId === userId ? snapshot.mine : null;
}

// Applied after the initial load settles: a tap made while it is still in flight would otherwise
// be overwritten by the load's older answer.
async function update(change: (mine: MyInterest) => MyInterest) {
  if (inFlight) await inFlight.promise;
  if (state.mine) publish({ ...state, mine: change(state.mine) });
}

async function send(token: string, method: 'POST' | 'DELETE', body: Record<string, unknown>): Promise<string | null> {
  try {
    const r = await fetch('/api/artist-interest', { method, headers: authHeaders(token), body: JSON.stringify(body) });
    if (r.ok) return null;
    const data = await r.json().catch(() => ({}));
    return (data as { error?: string }).error ?? 'Could not save that — try again';
  } catch (err) {
    Sentry.captureException(err, { extra: { context: `artistInterest.${method}` } });
    return 'Could not save that — try again';
  }
}

/** Record or withdraw "I'd tip them". Returns an error message, or null on success. */
export async function setTipInterest(token: string, slug: string, on: boolean): Promise<string | null> {
  const error = await send(token, on ? 'POST' : 'DELETE', { slug, kind: 'tip' });
  if (!error) {
    await update(mine => {
      const tip = new Set(mine.tip);
      if (on) tip.add(slug); else tip.delete(slug);
      return { ...mine, tip };
    });
  }
  return error;
}

/** Set the fan's city for this artist, or clear it with null. */
export async function setCityInterest(token: string, slug: string, city: string | null): Promise<string | null> {
  const error = await send(token, city ? 'POST' : 'DELETE', city ? { slug, kind: 'city', city } : { slug, kind: 'city' });
  if (!error) {
    await update(mine => {
      const cities = { ...mine.cities };
      if (city) cities[slug] = city.replace(/\s+/g, ' ').trim(); else delete cities[slug];
      return { ...mine, cities };
    });
  }
  return error;
}

export async function suggestCities(token: string, text: string, signal?: AbortSignal): Promise<string[]> {
  if (text.trim().length < 2) return [];
  try {
    const r = await fetch(`/api/artist-interest?suggest=${encodeURIComponent(text)}`, { headers: authHeaders(token), signal });
    if (!r.ok) return [];
    return ((await r.json()) as { suggestions: string[] }).suggestions;
  } catch {
    return [];
  }
}

/** Full counts for the artist's own dashboard. Throws on failure so the panel can say so. */
export async function getDashboardInterest(token: string, slug: string, signal?: AbortSignal): Promise<InterestCounts> {
  const r = await fetch(`/api/artist-interest?view=dashboard&slug=${encodeURIComponent(slug)}`, {
    headers: authHeaders(token),
    signal,
  });
  if (!r.ok) throw new Error(`artist-interest dashboard: HTTP ${r.status}`);
  return r.json();
}
