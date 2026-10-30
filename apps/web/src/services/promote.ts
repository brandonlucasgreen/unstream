// Client for release autopost: the Promote page's settings (/api/artist-promote) and starting a
// Buffer connection that comes back to it (/api/me/buffer/start).

import type { AutopostKind, TemplateRelease } from '../../../../api/shared/autopost-templates';

export interface PromoteSettings {
  enabled: boolean;
  enabledAt: string | null;
  /** null means Recommended. */
  postsPerWeek: number | null;
  timezone: string;
  /** HH:MM, or null for Recommended: the channel's Buffer queue picks the time. */
  postTime: string | null;
  organizationId: string | null;
  channelIds: string[];
  kindsOff: AutopostKind[];
  /** The artist's own variants per kind; a kind missing here uses Unstream's defaults. */
  templates: Partial<Record<AutopostKind, string[]>> | null;
  /** Why posting stopped on its own, e.g. 'buffer_disconnected'. */
  pausedReason: string | null;
}

export interface PromoteChannel {
  id: string;
  name: string;
  service: string;
  /** Whether autopost writes for this network. */
  supported: boolean;
}

export type PromoteBuffer =
  | { connected: false }
  | { connected: true; organizations: { id: string; name: string }[]; organizationId: string | null; channels: PromoteChannel[] };

/** One channel's copy of a post in Buffer. */
export interface PromoteChannelState {
  channelId: string;
  service: string;
  /**
   * Buffer's own status (scheduled, sending, sent, error, draft, needs_approval), 'missing' when
   * Buffer no longer has it, or 'unknown' when Buffer couldn't be asked just now.
   */
  status: string;
  dueAt: string | null;
  link: string | null;
  error: string | null;
}

/** Where a post stands: see api/functions/autopost-schedule-view.ts. */
export type PromotePostState =
  | { is: 'planned'; toBufferAt: string; lastError: string | null }
  | { is: 'sending' }
  | { is: 'failed'; error: string | null }
  | { is: 'in_buffer'; channels: PromoteChannelState[]; skipped: string | null };

export interface ScheduledPost {
  at: string;
  date: string;
  kind: AutopostKind;
  release: { title: string; slug: string } | null;
  imageUrl: string | null;
  imageOnInstagram: boolean;
  /** As it reads on the networks other than Instagram; null when no template could be filled. */
  text: string | null;
  state: PromotePostState;
}

/** What the page polls: the parts that change without the artist doing anything. */
export interface PromoteSchedule {
  pausedReason: string | null;
  /** The artist's own date today, YYYY-MM-DD: where "Coming up"'s weeks start. */
  today: string;
  comingUp: ScheduledPost[];
  recent: ScheduledPost[];
}

export type PromotePage =
  | { available: false }
  | {
    available: true;
    artist: { name: string; slug: string; photoUrl: string | null };
    saved: boolean;
    settings: PromoteSettings;
    releaseCount: number;
    recommendedPerWeek: number;
    takesTips: boolean;
    previewRelease: TemplateRelease | null;
    buffer: PromoteBuffer;
    today: string;
    comingUp: ScheduledPost[];
    recent: ScheduledPost[];
  };

export class PromoteApiError extends Error {
  readonly status: number;
  /** Per kind, what's wrong with the templates, when that's why a save was refused. */
  readonly problems?: Record<string, string[]>;
  constructor(message: string, status: number, problems?: Record<string, string[]>) {
    super(message);
    this.name = 'PromoteApiError';
    this.status = status;
    this.problems = problems;
  }
}

async function call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const { error, problems } = body as { error?: string; problems?: Record<string, string[]> };
    throw new PromoteApiError(error ?? `HTTP ${r.status}`, r.status, problems);
  }
  return body as T;
}

export function getPromotePage(token: string, slug: string): Promise<PromotePage> {
  return call(token, `/api/artist-promote?artist=${encodeURIComponent(slug)}`);
}

export function getPromoteSchedule(token: string, slug: string): Promise<PromoteSchedule> {
  return call(token, `/api/artist-promote?artist=${encodeURIComponent(slug)}&part=schedule`);
}

export type PromoteSettingsInput = Omit<PromoteSettings, 'enabledAt' | 'pausedReason'>;

export function savePromoteSettings(token: string, slug: string, settings: PromoteSettingsInput): Promise<PromotePage> {
  return call(token, `/api/artist-promote?artist=${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify(settings) });
}

/** Where to send the artist to connect Buffer; Buffer sends them back to the Promote page. */
export async function startBufferConnection(token: string, slug: string): Promise<string> {
  const { authorizeUrl } = await call<{ authorizeUrl?: string; available?: boolean }>(token, '/api/me/buffer/start', {
    method: 'POST',
    body: JSON.stringify({ returnTo: `/promote/${slug}` }),
  });
  if (!authorizeUrl) throw new PromoteApiError('Buffer isn’t available right now', 503);
  return authorizeUrl;
}
