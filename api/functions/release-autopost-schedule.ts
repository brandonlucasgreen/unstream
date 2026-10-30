// One artist's release autopost schedule, from what the database holds.
//
// **The sweep and the Promote page's "Coming up" both call this, and must.** "Coming up" is a
// promise: what it shows is what will post. Both get it from the same planner, over the same
// window (PLAN_HORIZON_DAYS), from the same inputs, built here in one place.

import { BANDCAMP_FRIDAY_DATES } from '../shared/bandcamp-friday';
import { AUTOPOST_KINDS, type AutopostKind } from '../shared/autopost-templates';
import { PLAN_HORIZON_DAYS, localDate, localInstant, planSlots, type PastPost, type PlannedPost } from './autopost-plan';
import { variantsFor } from './autopost-channel-post';
import type { AutopostArtist, AutopostRelease, AutopostSettings } from './release-autopost-db';

/** How far ahead of its time the sweep hands a post to Buffer (release-autopost-sweep.ts, "Why 72 hours ahead"). */
export const PUSH_AHEAD_HOURS = 72;

/**
 * The Buffer tag on every autopost, so Buffer's analytics can tell them apart, and the Promote
 * page can read back where each one stands.
 */
export const AUTOPOST_TAG = { name: 'unstream: release autopost', color: '#2F9E6E' };

export function planForArtist(
  settings: Pick<AutopostSettings, 'postsPerWeek' | 'timezone' | 'postTime' | 'kindsOff' | 'templates'> & { enabledAt: string },
  artist: Pick<AutopostArtist, 'photoUrl'>,
  releases: AutopostRelease[],
  history: PastPost[],
  now: Date,
): PlannedPost[] {
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
      // Uploads arrive with Build plan step 4.
      uploadIds: [],
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
    history,
    // Campaigns arrive with Build plan step 3.
    campaigns: [],
    bandcampFridays: BANDCAMP_FRIDAY_DATES,
    from: planFrom(settings, now),
    to: new Date(now.getTime() + PLAN_HORIZON_DAYS * 86_400_000).toISOString(),
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
export function isDueToPush(slot: PlannedPost, now: Date, pushAheadHours: number): boolean {
  return new Date(slot.at).getTime() < now.getTime() + pushAheadHours * 3_600_000;
}
