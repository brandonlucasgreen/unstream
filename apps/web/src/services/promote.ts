// Client for the Promote page: release autopost's settings (/api/artist-promote), starting a
// Buffer connection that comes back to it (/api/me/buffer/start), the asset library
// (/api/artist-promote/assets) and release campaigns (/api/artist-campaigns).

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
  /** An autopost's kind, or 'campaign' for a release campaign's post. */
  kind: AutopostKind | 'campaign';
  /** A campaign post's step (api/shared/campaign-steps.ts); null for an autopost. */
  step: string | null;
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

// ---------------------------------------------------------------------------------------------
// The asset library
// ---------------------------------------------------------------------------------------------

export interface PromoteAsset {
  id: string;
  url: string;
  width: number;
  height: number;
  /** Inside Instagram's 4:5 to 1.91:1 shape range. */
  instagramOk: boolean;
}

export type PromoteAssets = { available: false } | { available: true; max: number; assets: PromoteAsset[] };

const assetsUrl = (slug: string) => `/api/artist-promote/assets?artist=${encodeURIComponent(slug)}`;

export function getPromoteAssets(token: string, slug: string): Promise<PromoteAssets> {
  return call(token, assetsUrl(slug));
}

/** Upload one image, already resized and encoded by the browser, as base64. */
export function uploadPromoteAsset(token: string, slug: string, base64: string): Promise<PromoteAssets> {
  return call(token, assetsUrl(slug), { method: 'POST', body: JSON.stringify({ data: base64 }) });
}

export function removePromoteAsset(token: string, slug: string, id: string): Promise<PromoteAssets> {
  return call(token, `${assetsUrl(slug)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------------------------
// Release campaigns
// ---------------------------------------------------------------------------------------------

export interface CampaignRelease {
  id: string;
  title: string;
  slug: string;
  releaseType: string | null;
  releaseDate: string | null;
  datePrecision: string;
  status: 'announced' | 'released';
  artworkUrl: string | null;
  onBandcamp: boolean;
  /** The release as the template language reads it, for previews. */
  template: TemplateRelease;
}

/** A post as the editor holds it. `id` and `status` only once it's saved. */
export interface CampaignPostDraft {
  id?: string;
  step: string;
  date: string;
  /** The artist's words, in the template language. */
  text: string;
  /** 'cover', 'photo', 'upload:{id}', or null for none. */
  imageKey: string | null;
  status?: 'planned' | 'pushing' | 'pushed' | 'failed';
  error?: string | null;
}

/** The days autopost posts on around a campaign. */
export interface AutopostDay {
  date: string;
  kind: string;
}

export interface SavedCampaign {
  id: string;
  releaseId: string;
  release: { title: string; artworkUrl: string | null } | null;
  releaseDate: string;
  posts: CampaignPostDraft[];
  autopost: AutopostDay[];
}

export type CampaignsPage =
  | { available: false }
  | {
    available: true;
    artist: { name: string; slug: string; photoUrl: string | null };
    /** The artist's own date today, YYYY-MM-DD. */
    today: string;
    bufferConnected: boolean;
    /** The networks of the channels ticked on the Autopost tab, where campaign posts go too. */
    services: string[];
    autopostOn: boolean;
    pausedReason: string | null;
    releases: CampaignRelease[];
    uploads: { id: string; url: string; instagramOk: boolean }[];
    bandcampFridays: string[];
    campaigns: SavedCampaign[];
  };

const campaignsUrl = (slug: string, query = '') => `/api/artist-campaigns?artist=${encodeURIComponent(slug)}${query}`;

export function getCampaignsPage(token: string, slug: string): Promise<CampaignsPage> {
  return call(token, campaignsUrl(slug));
}

export function proposeCampaign(token: string, slug: string, input: { releaseId: string; releaseDate: string; startDate: string }): Promise<{ posts: CampaignPostDraft[]; autopost: AutopostDay[] }> {
  return call(token, campaignsUrl(slug, '&action=propose'), { method: 'POST', body: JSON.stringify(input) });
}

export function campaignOverlay(token: string, slug: string, input: { releaseId: string; dates: string[]; campaignId: string | null }): Promise<{ autopost: AutopostDay[] }> {
  return call(token, campaignsUrl(slug, '&action=overlay'), { method: 'POST', body: JSON.stringify(input) });
}

/** Schedule a new campaign (no id) or replace an existing one's unsent posts. */
export function saveCampaign(token: string, slug: string, campaign: { id: string | null; releaseId: string; releaseDate: string; posts: CampaignPostDraft[] }): Promise<CampaignsPage> {
  // Only what the artist can change; posts already in Buffer are left as they are by the server.
  const posts = campaign.posts
    .filter(p => p.status !== 'pushed' && p.status !== 'pushing')
    .map(p => ({ step: p.step, date: p.date, text: p.text, imageKey: p.imageKey }));
  const body = JSON.stringify({ releaseId: campaign.releaseId, releaseDate: campaign.releaseDate, posts });
  return campaign.id
    ? call(token, campaignsUrl(slug, `&id=${encodeURIComponent(campaign.id)}`), { method: 'PUT', body })
    : call(token, campaignsUrl(slug), { method: 'POST', body });
}

export function cancelCampaign(token: string, slug: string, id: string): Promise<CampaignsPage> {
  return call(token, campaignsUrl(slug, `&id=${encodeURIComponent(id)}`), { method: 'DELETE' });
}
