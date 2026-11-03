// One artist's release autopost schedule, from what the database holds.
//
// **The sweep and the Promote page's "Coming up" both call this, and must.** "Coming up" is a
// promise: what it shows is what will post. Both get it from the same planner, over the same
// window (PLAN_HORIZON_DAYS), from the same inputs, built here in one place.

import { BANDCAMP_FRIDAY_DATES } from '../shared/bandcamp-friday';
import { AUTOPOST_KINDS, type AutopostKind, type TemplateRelease } from '../shared/autopost-templates';
import { PLAN_HORIZON_DAYS, localDate, localInstant, planSlots, type PastPost, type PlanCampaign, type PlannedPost } from './autopost-plan';
import { fitsInstagram } from './autopost-media';
import { variantsFor } from './autopost-channel-post';
import type { AutopostArtist, AutopostRelease, AutopostSettings } from './release-autopost-db';
import type { PromoteAsset } from './promote-assets-db';
import { campaignsForPlan, type Campaign } from './release-campaigns-db';

/** How far ahead of its time the sweep hands a post to Buffer (release-autopost-sweep.ts, "Why 72 hours ahead"). */
export const PUSH_AHEAD_HOURS = 72;

/**
 * The Buffer tag on every autopost, so Buffer's analytics can tell them apart, and the Promote
 * page can read back where each one stands.
 */
export const AUTOPOST_TAG = { name: 'unstream: release autopost', color: '#2F9E6E' };

/** The Buffer tag on every campaign post (spec, "Release campaigns"). */
export const CAMPAIGN_TAG = { name: 'unstream: release campaign', color: '#7C5CC4' };

/** What the asset library and campaigns add to an artist's plan. */
export interface PlanExtras {
  uploads: PromoteAsset[];
  campaigns: Campaign[];
}

export function planForArtist(
  settings: Pick<AutopostSettings, 'postsPerWeek' | 'timezone' | 'postTime' | 'kindsOff' | 'templates'> & { enabledAt: string },
  artist: Pick<AutopostArtist, 'photoUrl'>,
  releases: AutopostRelease[],
  history: PastPost[],
  extras: PlanExtras,
  now: Date,
  /** Plan further than PLAN_HORIZON_DAYS, for a campaign's preview only; the sweep never passes it. */
  horizonDays: number = PLAN_HORIZON_DAYS,
): PlannedPost[] {
  const fromCampaigns = campaignsForPlan(extras.campaigns, localDate(now.toISOString(), settings.timezone));
  const plan: PlanCampaign[] = fromCampaigns.campaigns;
  return planSlots({
    settings: {
      postsPerWeek: settings.postsPerWeek,
      timezone: settings.timezone,
      postTime: settings.postTime,
      enabledAt: settings.enabledAt,
      kindsOff: settings.kindsOff,
      variantCounts: Object.fromEntries(AUTOPOST_KINDS.map(k => [k, variantsFor(k, settings.templates).length])) as Record<AutopostKind, number>,
      // Its shape is checked when it's copied; one outside Instagram's range skips Instagram then.
      artistPhoto: artist.photoUrl ? { instagramOk: true } : null,
      uploads: extras.uploads.map(u => ({ id: u.id, instagramOk: fitsInstagram(u) })),
    },
    releases: releases.map(r => ({
      id: r.id,
      releaseDate: r.releaseDate,
      datePrecision: r.datePrecision,
      status: r.status,
      cataloguedAt: r.createdAt,
      onBandcamp: r.sources.some(s => s.platform === 'bandcamp'),
      hasCover: Boolean(r.artworkUrl),
    })),
    history: [...history, ...fromCampaigns.history].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
    campaigns: plan,
    bandcampFridays: BANDCAMP_FRIDAY_DATES,
    from: planFrom(settings, now),
    to: new Date(now.getTime() + horizonDays * 86_400_000).toISOString(),
  });
}

/**
 * Where the plan starts. With a set time, now. Queued posts ("Recommended") are placed at the
 * start of their day and go out at a time from each channel's posting schedule, so today's is
 * still to come until that day's last posting time has passed.
 */
function planFrom(settings: { postTime: string | null; timezone: string }, now: Date): string {
  if (settings.postTime !== null) return now.toISOString();
  return localInstant(localDate(now.toISOString(), settings.timezone), '00:00', settings.timezone);
}

/**
 * Whether a planned slot is due to go to Buffer now: pushAheadHours before it, so the artist sees
 * it in Buffer first. The same for both posting times: a queued slot sits at its day's start, and
 * the sweep reads its time from the channel's posting schedule when it hands it over.
 */
export function isDueToPush(slot: Pick<PlannedPost, 'at'>, now: Date, pushAheadHours: number): boolean {
  return new Date(slot.at).getTime() < now.getTime() + pushAheadHours * 3_600_000;
}

/** A release as the template language reads it. */
export function toTemplateRelease(r: AutopostRelease): TemplateRelease {
  return {
    title: r.title,
    slug: r.slug,
    releaseType: r.releaseType,
    releaseDate: r.releaseDate,
    datePrecision: r.datePrecision,
    note: r.note,
    sources: r.sources,
  };
}
