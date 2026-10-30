// Release autopost: which post goes on which day (docs/specs/release-autopost-spec.md,
// "How often" and "Filling each slot").
//
// **This is a pure function, and has to stay one.** It takes everything as arguments and reads
// no clock, database or randomness; ties are broken by release id. That's what makes the
// Promote page's "Coming up" honest: what it shows is exactly what will post. Tests fail if this
// file reaches for the current time or Math.random.
//
// Dates come in two kinds and are kept apart by name: an *instant* is an ISO timestamp, a *date*
// is the artist's local calendar day, YYYY-MM-DD, in their own timezone. Every rule about days
// ("Friday", "within 14 days", "the same week") is about local dates.

import type { AutopostKind } from '../shared/autopost-templates';
import type { PostingDay } from './buffer-client';

export type { AutopostKind };

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/** A release that qualifies for posting. The caller filters (not hidden, not in review, sold on a
 *  platform from the artist's own links); this file never sees one that doesn't. */
export interface PlanRelease {
  id: string;
  releaseDate: string | null;
  datePrecision: string;
  status: 'announced' | 'released';
  /** When Unstream first catalogued it (`releases.created_at`), an instant. */
  cataloguedAt: string;
  onBandcamp: boolean;
  hasCover: boolean;
}

export interface PlanSettings {
  /** null means "Recommended", which grows with the catalogue. */
  postsPerWeek: number | null;
  timezone: string;
  /**
   * Local time of day, HH:MM, or null for "Recommended": the post goes out at a time from the
   * channel's Buffer posting schedule that day (`queueTimeOn`). A queued slot is placed at the
   * day's start.
   */
  postTime: string | null;
  /** When autopost was switched on, an instant. Only releases catalogued after it get release moments. */
  enabledAt: string;
  kindsOff: AutopostKind[];
  /** How many template variants each kind has. A kind with none is off. */
  variantCounts: Partial<Record<AutopostKind, number>>;
  /** null when Unstream holds no photo of the artist. */
  artistPhoto: { instagramOk: boolean } | null;
  uploadIds: string[];
}

/** A post already handed to Buffer: autopost's own, or a campaign's. */
export interface PastPost {
  at: string;
  kind: AutopostKind | 'campaign';
  releaseId: string | null;
  templateIndex: number | null;
  imageKey: string | null;
  imageOnInstagram: boolean;
}

/** An active campaign: its release, and the local dates its posts go out on. */
export interface PlanCampaign {
  releaseId: string;
  dates: string[];
}

export interface PlanInput {
  settings: PlanSettings;
  releases: PlanRelease[];
  history: PastPost[];
  campaigns: PlanCampaign[];
  /** Local dates, YYYY-MM-DD (`BANDCAMP_FRIDAY_DATES`). Passed in so tests don't age. */
  bandcampFridays: string[];
  /** Plan slots at or after this instant… */
  from: string;
  /** …and before this one. */
  to: string;
}

export interface PlannedPost {
  at: string;
  date: string;
  kind: AutopostKind;
  /** null for a call for support. */
  releaseId: string | null;
  templateIndex: number;
  /** `cover:{releaseId}`, `photo` or `upload:{id}`; the caller turns it into a URL. */
  imageKey: string | null;
  /** false means the Instagram channel skips this post. */
  imageOnInstagram: boolean;
}

// ---------------------------------------------------------------------------------------------
// The rules, as numbers
// ---------------------------------------------------------------------------------------------

/** Days of the week (0 = Sunday) that post, by posts a week. Friday is in every pattern. */
export const SLOT_DAYS: Record<number, number[]> = {
  1: [5],
  2: [2, 5],
  3: [1, 3, 5],
  4: [1, 3, 5, 0],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
  7: [0, 1, 2, 3, 4, 5, 6],
};

/**
 * How far ahead the sweep plans, and the Promote page's "Coming up" shows. **Both must plan the
 * same window:** fixed-date posts are placed across the whole window first, and the catalogue
 * steers around them, so a shorter window could choose differently for the same day.
 */
export const PLAN_HORIZON_DAYS = 28;

const PREORDER_MIN_DAYS_OUT = 3;
const OUT_NOW_WINDOW_DAYS = 14;
const STILL_NEW_WINDOW_DAYS = 42;
const MIN_CATALOGUE_SPACING_DAYS = 14;
/** No release is named twice within this many days, whatever the reason. */
const MIN_GAP_DAYS = 3;
/** A call for support at most once in this many posts… */
const SUPPORT_EVERY = 4;
/** …and only at this many posts a week or more. Below it, every slot belongs to the music. */
const SUPPORT_MIN_PER_WEEK = 3;
const INSTAGRAM_IMAGE_REPEAT_DAYS = 28;

/** 1–7 releases → 1 a week, 8–14 → 2, 15 or more → 3. None → nothing to post. */
export function recommendedPostsPerWeek(qualifyingReleases: number): number {
  if (qualifyingReleases <= 0) return 0;
  return Math.min(3, Math.ceil(qualifyingReleases / 7));
}

// ---------------------------------------------------------------------------------------------
// Calendar helpers (local dates as YYYY-MM-DD strings)
// ---------------------------------------------------------------------------------------------

function dateToUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, days: number): string {
  return new Date(dateToUtcMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateToUtcMs(b) - dateToUtcMs(a)) / 86_400_000);
}

function dayOfWeek(date: string): number {
  return new Date(dateToUtcMs(date)).getUTCDay();
}

/** The Monday that starts this date's week. */
function weekStart(date: string): string {
  return addDays(date, -((dayOfWeek(date) + 6) % 7));
}

function wallClock(instantMs: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** The artist's local date at an instant. */
export function localDate(instant: string, timezone: string): string {
  const c = wallClock(new Date(instant).getTime(), timezone);
  return `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
}

/** The instant a local date and time happens in a timezone, daylight saving included. */
export function localInstant(date: string, time: string, timezone: string): string {
  const [hh, mm] = time.split(':').map(Number);
  const wall = dateToUtcMs(date) + (hh * 60 + mm) * 60_000;
  const offsetAt = (ms: number) => {
    const c = wallClock(ms, timezone);
    return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - ms;
  };
  // Twice, because the offset at the first guess can be the other side of a clock change.
  const guess = wall - offsetAt(wall);
  return new Date(wall - offsetAt(guess)).toISOString();
}

/** Leave Buffer this long to take a post before its time. */
const QUEUE_LEAD_MS = 10 * 60_000;

/** A post's time on one channel, or why that channel has none that day. */
export type QueueTime = { at: string } | { none: string };

/** "9:15", "09:15" or "09:15:00" as HH:MM; null for anything else. */
function readClockTime(time: string): string | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(time.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * When a "Pick days & times for me" post goes out on one channel: the earliest time in that
 * channel's Buffer posting schedule on the post's day, in the channel's timezone, that's still
 * ahead of `now`. When there's none, says why (paused, empty, unreadable, or already past), so
 * the sweep's log can tell the artist's choice from a format we didn't expect.
 *
 * Read from the schedule rather than handed to Buffer's queue (`addToQueue`), because the queue
 * places a post in the next open slot from *now*: a post handed over three days early would go
 * out within hours. Scheduling it at its own day's slot lets it reach Buffer early, where the
 * artist can see it.
 */
export function queueTimeOn(date: string, schedule: PostingDay[], timezone: string, now: Date): QueueTime {
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dayOfWeek(date)];
  const day = schedule.find(d => d.day === weekday);
  if (!day || day.times.length === 0) return { none: `no posting times in its Buffer schedule on ${weekday}` };
  if (day.paused) return { none: `its Buffer schedule is paused on ${weekday}` };
  const instants = day.times
    .map(readClockTime)
    .filter((t): t is string => t !== null)
    .map(t => localInstant(date, t, timezone))
    .sort();
  if (instants.length === 0) return { none: `couldn’t read its Buffer posting times (${day.times.join(', ')})` };
  const earliest = now.getTime() + QUEUE_LEAD_MS;
  const at = instants.find(i => new Date(i).getTime() >= earliest);
  return at ? { at } : { none: `every posting time in its Buffer schedule on ${date} has passed` };
}

// ---------------------------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------------------------

interface Mention {
  date: string;
  kind: AutopostKind | 'campaign';
  releaseId: string | null;
  templateIndex: number | null;
  imageKey: string | null;
  imageOnInstagram: boolean;
}

/** Newest first: release date, then when catalogued, then id, so ties are stable. */
function newestFirst(a: PlanRelease, b: PlanRelease): number {
  if (a.releaseDate !== b.releaseDate) {
    if (!a.releaseDate) return 1;
    if (!b.releaseDate) return -1;
    return a.releaseDate < b.releaseDate ? 1 : -1;
  }
  if (a.cataloguedAt !== b.cataloguedAt) return a.cataloguedAt < b.cataloguedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Every autopost due between `from` and `to`, in date order.
 *
 * Each week has as many slots as the artist chose, on fixed days. Slots are filled in priority
 * order: fixed-date posts (release day, Bandcamp Friday) on their own date, taking the week's
 * nearest slot; then release moments (pre-order, out now, still new); then the catalogue, which
 * a call for support occasionally replaces. A slot with nothing that qualifies stays empty
 * rather than repeating something.
 */
export function planSlots(input: PlanInput): PlannedPost[] {
  const { settings, history, campaigns, bandcampFridays } = input;
  const tz = settings.timezone;

  const perWeek = Math.max(1, Math.min(7,
    settings.postsPerWeek ?? recommendedPostsPerWeek(input.releases.length)));
  if (input.releases.length === 0) return [];

  const startMs = Math.max(new Date(input.from).getTime(), new Date(settings.enabledAt).getTime());
  const endMs = new Date(input.to).getTime();
  const enabledMs = new Date(settings.enabledAt).getTime();

  const campaignDays = new Set(campaigns.flatMap(c => c.dates));
  const campaignReleases = new Set(campaigns.map(c => c.releaseId));
  // A release with a campaign is left to the campaign.
  const releases = input.releases.filter(r => !campaignReleases.has(r.id)).sort(newestFirst);
  const byId = new Map(releases.map(r => [r.id, r]));

  const kindOn = (kind: AutopostKind) =>
    !settings.kindsOff.includes(kind) && (settings.variantCounts[kind] ?? 0) > 0;

  // Everything said so far, and everything planned as we go: the record that spacing, variant
  // turns and image repeats are measured against.
  const timeline: Mention[] = history.map(p => ({
    date: localDate(p.at, tz),
    kind: p.kind,
    releaseId: p.releaseId,
    templateIndex: p.templateIndex,
    imageKey: p.imageKey,
    imageOnInstagram: p.imageOnInstagram,
  }));
  const planned: PlannedPost[] = [];

  const instantOf = (date: string) => localInstant(date, settings.postTime ?? '00:00', tz);
  const isOpen = (date: string) => {
    const ms = new Date(instantOf(date)).getTime();
    return ms >= startMs && ms < endMs && !campaignDays.has(date);
  };
  const isNewSinceEnabled = (r: PlanRelease) => new Date(r.cataloguedAt).getTime() >= enabledMs;

  const mentionedWithin = (releaseId: string, date: string, days: number) =>
    timeline.some(m => m.releaseId === releaseId && Math.abs(daysBetween(m.date, date)) < days);
  const everSaid = (releaseId: string, kinds: (AutopostKind | 'campaign')[]) =>
    timeline.some(m => m.releaseId === releaseId && kinds.includes(m.kind));
  const autopostsBefore = (date: string) =>
    timeline.filter(m => m.kind !== 'campaign' && m.date < date).sort((a, b) => (a.date < b.date ? -1 : 1));

  const nextVariant = (kind: AutopostKind, date: string): number => {
    const count = settings.variantCounts[kind] ?? 0;
    const last = timeline
      .filter(m => m.kind === kind && m.templateIndex !== null && m.date <= date)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .pop();
    return last ? (last.templateIndex! + 1) % count : 0;
  };

  // Looking back only. Fixed-date posts are placed before the rest, so looking forward too would
  // let a Bandcamp Friday three weeks out take Instagram away from today's post.
  const usedOnInstagramRecently = (key: string, date: string) =>
    timeline.some(m => m.imageOnInstagram && m.imageKey === key
      && m.date <= date && daysBetween(m.date, date) < INSTAGRAM_IMAGE_REPEAT_DAYS);

  const coverKey = (releaseId: string | null) => {
    const r = releaseId ? byId.get(releaseId) : undefined;
    return r?.hasCover ? `cover:${r.id}` : null;
  };

  /**
   * Release moments and Bandcamp Friday use the release's cover. A catalogue post rotates
   * through its cover, the artist's photo and uploads, and a call for support through the photo
   * and uploads (covers belong to their releases' own posts), never showing one on Instagram
   * twice in four weeks. With nothing fresh left, Instagram skips the post and the other
   * networks still get the cover or photo.
   */
  const pickImage = (kind: AutopostKind, releaseId: string | null, date: string) => {
    if (kind !== 'catalogue' && kind !== 'support') {
      const key = coverKey(releaseId);
      return { imageKey: key, imageOnInstagram: key !== null };
    }
    const photoForInstagram = settings.artistPhoto?.instagramOk ? ['photo'] : [];
    const uploads = settings.uploadIds.map(id => `upload:${id}`);
    const candidates = kind === 'catalogue'
      ? [coverKey(releaseId), ...photoForInstagram, ...uploads]
      : [...photoForInstagram, ...uploads];
    for (const key of candidates) {
      if (key && !usedOnInstagramRecently(key, date)) return { imageKey: key, imageOnInstagram: true };
    }
    const fallback = kind === 'catalogue' ? coverKey(releaseId) : (settings.artistPhoto ? 'photo' : null);
    return { imageKey: fallback, imageOnInstagram: false };
  };

  const place = (date: string, kind: AutopostKind, releaseId: string | null) => {
    const image = pickImage(kind, releaseId, date);
    const post: PlannedPost = {
      at: instantOf(date), date, kind, releaseId, templateIndex: nextVariant(kind, date), ...image,
    };
    planned.push(post);
    timeline.push({ date, kind, releaseId, templateIndex: post.templateIndex, ...image });
  };

  /** The fixed-date posts that fall in this week, most specific first. */
  const fixedPostsIn = (days: string[]) => {
    const fixed: { date: string; kind: AutopostKind; releaseId: string }[] = [];
    for (const r of releases) {
      if (!r.releaseDate || r.datePrecision !== 'day' || !days.includes(r.releaseDate)) continue;
      // Caught before the day, and catalogued after autopost was switched on.
      if (!isNewSinceEnabled(r) || localDate(r.cataloguedAt, tz) >= r.releaseDate) continue;
      if (everSaid(r.id, ['release_day'])) continue;
      fixed.push({ date: r.releaseDate, kind: 'release_day', releaseId: r.id });
    }
    for (const friday of bandcampFridays) {
      if (!days.includes(friday)) continue;
      const newest = releases.find(r => r.onBandcamp && r.status === 'released'
        && r.releaseDate !== null && r.releaseDate <= friday);
      if (newest) fixed.push({ date: friday, kind: 'bandcamp_friday', releaseId: newest.id });
    }
    return fixed;
  };

  /** Pre-order, out now or still new, for the newest release that has one due. */
  const releaseMoment = (date: string): { kind: AutopostKind; releaseId: string } | null => {
    const previous = autopostsBefore(date).pop();
    for (const r of releases) {
      if (!r.releaseDate || !isNewSinceEnabled(r) || mentionedWithin(r.id, date, MIN_GAP_DAYS)) continue;
      const sinceRelease = daysBetween(r.releaseDate, date);

      if (kindOn('preorder') && r.status === 'announced' && -sinceRelease >= PREORDER_MIN_DAYS_OUT
        && !everSaid(r.id, ['preorder'])) {
        return { kind: 'preorder', releaseId: r.id };
      }
      if (sinceRelease < 0) continue;
      if (kindOn('out_now') && sinceRelease <= OUT_NOW_WINDOW_DAYS
        && !everSaid(r.id, ['release_day', 'out_now'])) {
        return { kind: 'out_now', releaseId: r.id };
      }
      // At most one slot in two, so the catalogue still gets a turn.
      if (kindOn('still_new') && sinceRelease <= STILL_NEW_WINDOW_DAYS && previous?.kind !== 'still_new') {
        return { kind: 'still_new', releaseId: r.id };
      }
    }
    return null;
  };

  // A release comes round again only after the catalogue's natural gap: how long the whole
  // catalogue takes to cycle at this rhythm, and never under two weeks.
  const spacing = Math.max(MIN_CATALOGUE_SPACING_DAYS, Math.floor((7 * input.releases.length) / perWeek));

  /** The release mentioned longest ago (never counts as longest), newest first on ties. */
  const catalogueRelease = (date: string): string | null => {
    if (!kindOn('catalogue')) return null;
    let best: { id: string; last: string } | null = null;
    for (const r of releases) {
      if (mentionedWithin(r.id, date, spacing)) continue;
      const last = timeline
        .filter(m => m.releaseId === r.id && m.date <= date)
        .reduce((latest, m) => (m.date > latest ? m.date : latest), '');
      // Strictly earlier wins, so on a tie the newer release (seen first) keeps its place.
      if (!best || last < best.last) best = { id: r.id, last };
    }
    return best?.id ?? null;
  };

  const supportDue = (date: string) => {
    if (perWeek < SUPPORT_MIN_PER_WEEK || !kindOn('support')) return false;
    const recent = autopostsBefore(date).slice(-(SUPPORT_EVERY - 1));
    return recent.length === SUPPORT_EVERY - 1 && recent.every(m => m.kind !== 'support');
  };

  const firstDate = localDate(new Date(startMs).toISOString(), tz);
  const lastDate = localDate(input.to, tz);
  const pattern = SLOT_DAYS[perWeek];

  const weeks: { days: string[]; slots: string[] }[] = [];
  for (let week = weekStart(firstDate); week <= lastDate; week = addDays(week, 7)) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
    weeks.push({ days, slots: days.filter(d => pattern.includes(dayOfWeek(d))) });
  }

  // Removes the week's remaining slot nearest a date (the earlier one on a tie).
  const takeNearestSlot = (slots: string[], date: string): boolean => {
    if (slots.length === 0) return false;
    let best = 0;
    for (let i = 1; i < slots.length; i++) {
      if (Math.abs(daysBetween(slots[i], date)) < Math.abs(daysBetween(slots[best], date))) best = i;
    }
    slots.splice(best, 1);
    return true;
  };

  // First every week's fixed-date posts, so the slots filled after can see them coming and
  // don't name the same release a few days before its release day or Bandcamp Friday.
  for (const { days, slots } of weeks) {
    // The weekly number is a promise: posts already made this week used up their slots.
    for (const m of timeline) {
      if (m.kind !== 'campaign' && days.includes(m.date)) takeNearestSlot(slots, m.date);
    }

    for (const f of fixedPostsIn(days)) {
      if (!kindOn(f.kind) || !isOpen(f.date)) continue;
      if (f.kind === 'bandcamp_friday' && timeline.some(m => m.kind === 'bandcamp_friday' && m.date === f.date)) continue;
      if (!takeNearestSlot(slots, f.date)) continue;
      place(f.date, f.kind, f.releaseId);
    }
  }

  // Then the rest, in date order.
  for (const { slots } of weeks) {
    for (const date of [...slots].sort()) {
      if (!isOpen(date)) continue;
      const moment = releaseMoment(date);
      if (moment) { place(date, moment.kind, moment.releaseId); continue; }
      const releaseId = catalogueRelease(date);
      if (!releaseId) continue;
      if (supportDue(date)) place(date, 'support', null);
      else place(date, 'catalogue', releaseId);
    }
  }

  return planned.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
