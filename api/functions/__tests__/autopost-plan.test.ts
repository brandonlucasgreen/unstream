// Release autopost: which post goes on which day (docs/specs/release-autopost-spec.md,
// "How often" and "Filling each slot").
//
// Every rule in the spec has a test here, because the planner's output is the artist's real
// schedule, shown to them in advance: a rule that drifts silently changes what posts in their
// name. November 2026 is used throughout: Monday 9th to Sunday 6 December, Eastern time, with
// the clocks going back on 1 November.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  localInstant,
  planSlots,
  queueTimeOn,
  recommendedPostsPerWeek,
  type PastPost,
  type PlanInput,
  type PlanRelease,
  type PlanSettings,
} from '../autopost-plan';

const settings = (over: Partial<PlanSettings> = {}): PlanSettings => ({
  postsPerWeek: 1,
  timezone: 'America/New_York',
  postTime: '10:00',
  enabledAt: '2026-10-01T00:00:00Z',
  kindsOff: [],
  variantCounts: { bandcamp_friday: 2, release_day: 2, preorder: 2, out_now: 2, still_new: 2, catalogue: 3, support: 2 },
  artistPhoto: null,
  uploadIds: [],
  ...over,
});

const rel = (id: string, releaseDate: string | null, over: Partial<PlanRelease> = {}): PlanRelease => ({
  id,
  releaseDate,
  datePrecision: 'day',
  status: 'released',
  cataloguedAt: '2026-01-01T00:00:00Z',
  onBandcamp: true,
  hasCover: true,
  ...over,
});

const past = (date: string, kind: PastPost['kind'], releaseId: string | null, over: Partial<PastPost> = {}): PastPost => ({
  at: `${date}T15:00:00.000Z`,
  kind,
  releaseId,
  templateIndex: 0,
  imageKey: releaseId ? `cover:${releaseId}` : null,
  imageOnInstagram: true,
  ...over,
});

const plan = (over: Partial<PlanInput> & { settings?: PlanSettings } = {}) => planSlots({
  settings: settings(),
  releases: [],
  history: [],
  campaigns: [],
  bandcampFridays: [],
  from: '2026-11-09T00:00:00Z',
  to: '2026-12-07T00:00:00Z',
  ...over,
});

const fourReleases = [rel('a', '2024-03-01'), rel('b', '2025-03-01'), rel('c', '2023-03-01'), rel('d', '2022-03-01')];
const summary = (posts: ReturnType<typeof plan>) => posts.map(p => `${p.date} ${p.kind} ${p.releaseId ?? '-'}`);

describe('how often', () => {
  it('recommends 1 a week up to 7 releases, 2 up to 14, then 3', () => {
    expect([0, 1, 7, 8, 14, 15, 40].map(recommendedPostsPerWeek)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it('uses the recommendation when the artist hasn’t picked a number', () => {
    const releases = Array.from({ length: 9 }, (_, i) => rel(`r${i}`, `2020-0${i + 1}-01`));
    const posts = plan({ settings: settings({ postsPerWeek: null }), releases });
    expect(posts.filter(p => p.date >= '2026-11-09' && p.date <= '2026-11-15').map(p => p.date)).toEqual(['2026-11-10', '2026-11-13']);
  });

  it('posts on the fixed days for each number, at the artist’s local time', () => {
    const posts = plan({ releases: fourReleases });
    expect(posts.map(p => p.date)).toEqual(['2026-11-13', '2026-11-20', '2026-11-27', '2026-12-04']);
    expect(posts[0].at).toBe('2026-11-13T15:00:00.000Z');

    const many = Array.from({ length: 20 }, (_, i) => rel(`r${i}`, `20${10 + i}-01-01`));
    const three = plan({ settings: settings({ postsPerWeek: 3 }), releases: many, to: '2026-11-16T00:00:00Z' });
    expect(three.map(p => p.date)).toEqual(['2026-11-09', '2026-11-11', '2026-11-13']);
  });

  it('follows daylight saving', () => {
    expect(localInstant('2026-10-30', '10:00', 'America/New_York')).toBe('2026-10-30T14:00:00.000Z');
    expect(localInstant('2026-11-06', '10:00', 'America/New_York')).toBe('2026-11-06T15:00:00.000Z');
  });

  // "Pick days & times for me" posts at a time from the channel's Buffer posting schedule.
  it('takes a queued post’s time from the channel’s posting schedule that day', () => {
    const schedule = [
      { day: 'fri', times: ['17:30', '09:15'], paused: false },
      { day: 'sat', times: ['11:00'], paused: true },
      { day: 'sun', times: [], paused: false },
    ];
    const wednesday = new Date('2026-11-11T12:00:00Z');
    // The earliest that day, in the channel's own timezone.
    expect(queueTimeOn('2026-11-13', schedule, 'America/New_York', wednesday)).toBe('2026-11-13T14:15:00.000Z');
    expect(queueTimeOn('2026-11-13', schedule, 'Europe/London', wednesday)).toBe('2026-11-13T09:15:00.000Z');
    // A paused day, an empty one, and a day the schedule doesn't list: no time.
    expect(queueTimeOn('2026-11-14', schedule, 'America/New_York', wednesday)).toBeNull();
    expect(queueTimeOn('2026-11-15', schedule, 'America/New_York', wednesday)).toBeNull();
    expect(queueTimeOn('2026-11-12', schedule, 'America/New_York', wednesday)).toBeNull();
    // On the day itself, only a time still ahead, with ten minutes for Buffer to take it.
    expect(queueTimeOn('2026-11-13', schedule, 'America/New_York', new Date('2026-11-13T14:10:00Z'))).toBe('2026-11-13T22:30:00.000Z');
    expect(queueTimeOn('2026-11-13', schedule, 'America/New_York', new Date('2026-11-13T22:25:00Z'))).toBeNull();
  });

  it('posts nothing before it was switched on, and nothing for an empty catalogue', () => {
    const posts = plan({ settings: settings({ enabledAt: '2026-11-18T00:00:00Z' }), releases: fourReleases });
    expect(posts[0].date).toBe('2026-11-20');
    expect(plan({ releases: [] })).toEqual([]);
  });
});

describe('the catalogue', () => {
  it('starts with releases never mentioned, newest first', () => {
    expect(plan({ releases: fourReleases }).map(p => p.releaseId)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('then picks the one mentioned longest ago, and never one inside its spacing', () => {
    // Four releases at one a week: the natural gap is 28 days.
    const posts = plan({ releases: fourReleases, history: [past('2026-11-02', 'catalogue', 'b')] });
    expect(posts.map(p => p.releaseId)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('leaves a slot empty rather than repeating a release', () => {
    // One release: two weeks' minimum spacing, so every other Friday.
    expect(plan({ releases: [rel('a', '2024-03-01')] }).map(p => p.date)).toEqual(['2026-11-13', '2026-11-27']);
  });

  it('takes turns through the template variants, carrying on from what was posted', () => {
    const posts = plan({ releases: fourReleases, history: [past('2026-10-30', 'catalogue', 'x', { templateIndex: 2 })] });
    expect(posts.map(p => p.templateIndex)).toEqual([0, 1, 2, 0]);
  });
});

describe('the weekly number is a promise', () => {
  it('counts a post already made this week', () => {
    const posts = plan({ releases: fourReleases, history: [past('2026-11-10', 'catalogue', 'x')] });
    expect(posts.map(p => p.date)).not.toContain('2026-11-13');
  });

  it('doesn’t count campaign posts against it', () => {
    const posts = plan({ releases: fourReleases, history: [past('2026-11-10', 'campaign', 'x')] });
    expect(posts.map(p => p.date)).toContain('2026-11-13');
  });
});

describe('fixed-date posts', () => {
  const newRelease = (over: Partial<PlanRelease> = {}) =>
    rel('new', '2026-11-17', { cataloguedAt: '2026-11-01T12:00:00Z', ...over });

  it('posts on release day itself, using up the week’s nearest slot', () => {
    const posts = plan({ releases: [...fourReleases, newRelease()] });
    const week = posts.filter(p => p.date >= '2026-11-16' && p.date <= '2026-11-22');
    expect(summary(week)).toEqual(['2026-11-17 release_day new']);
  });

  it('only for a release catalogued after autopost was switched on', () => {
    const posts = plan({ releases: [...fourReleases, newRelease({ cataloguedAt: '2026-09-01T00:00:00Z' })] });
    expect(posts.map(p => p.kind)).not.toContain('release_day');
  });

  it('a release found on or after its day gets "out now" instead', () => {
    const posts = plan({ releases: [...fourReleases, newRelease({ cataloguedAt: '2026-11-17T20:00:00Z' })] });
    expect(summary(posts)).toContain('2026-11-20 out_now new');
    expect(posts.map(p => p.kind)).not.toContain('release_day');
  });

  it('Bandcamp Friday is about their newest release that’s out on Bandcamp', () => {
    const releases = [...fourReleases, rel('mirlo-only', '2026-06-01', { onBandcamp: false })];
    const posts = plan({ releases, bandcampFridays: ['2026-11-13'] });
    expect(summary(posts)[0]).toBe('2026-11-13 bandcamp_friday b');
  });

  it('are placed first, so the catalogue doesn’t name the same release a few days earlier', () => {
    // b is the newest, so the catalogue would start with it on the 13th, a week before its
    // Bandcamp Friday on the 20th.
    const posts = plan({ releases: fourReleases, bandcampFridays: ['2026-11-20'] });
    expect(summary(posts).slice(0, 2)).toEqual(['2026-11-13 catalogue a', '2026-11-20 bandcamp_friday b']);
  });

  it('a switched-off kind doesn’t post', () => {
    const posts = plan({ settings: settings({ kindsOff: ['bandcamp_friday'] }), releases: fourReleases, bandcampFridays: ['2026-11-13'] });
    expect(posts.map(p => p.kind)).not.toContain('bandcamp_friday');
  });
});

describe('release moments', () => {
  it('a pre-order gets one post, then its release day', () => {
    const upcoming = rel('soon', '2026-12-01', { status: 'announced', cataloguedAt: '2026-11-01T00:00:00Z' });
    const posts = plan({ releases: [...fourReleases, upcoming] });
    expect(posts.filter(p => p.kind === 'preorder').map(p => p.date)).toEqual(['2026-11-13']);
    expect(summary(posts.filter(p => p.date >= '2026-11-30'))).toEqual(['2026-12-01 release_day soon']);
  });

  it('a new release is "still new" at most one slot in two', () => {
    const many = Array.from({ length: 20 }, (_, i) => rel(`r${i}`, `20${10 + i}-01-01`));
    const fresh = rel('fresh', '2026-11-02', { cataloguedAt: '2026-11-01T00:00:00Z' });
    const posts = plan({
      settings: settings({ postsPerWeek: 3, kindsOff: ['support'] }),
      releases: [...many, fresh],
      history: [past('2026-11-02', 'release_day', 'fresh')],
    });
    const kinds = posts.map(p => p.kind);
    expect(kinds).toContain('still_new');
    for (let i = 1; i < kinds.length; i++) {
      expect(kinds[i] === 'still_new' && kinds[i - 1] === 'still_new', summary(posts).join('\n')).toBe(false);
    }
  });
});

describe('calls for support', () => {
  const many = Array.from({ length: 20 }, (_, i) => rel(`r${i}`, `20${10 + i}-01-01`));

  it('replace a catalogue post at most once in four, at three or more a week', () => {
    const kinds = plan({ settings: settings({ postsPerWeek: 3 }), releases: many }).map(p => p.kind);
    expect(kinds.filter(k => k === 'support').length).toBeGreaterThan(0);
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === 'support') expect(kinds.slice(Math.max(0, i - 3), i)).not.toContain('support');
    }
  });

  it('never below three a week', () => {
    expect(plan({ settings: settings({ postsPerWeek: 2 }), releases: many }).map(p => p.kind)).not.toContain('support');
  });
});

describe('campaigns', () => {
  it('leave their release to the campaign and their days empty', () => {
    const posts = plan({ releases: fourReleases, campaigns: [{ releaseId: 'b', dates: ['2026-11-13'] }] });
    expect(posts.map(p => p.releaseId)).not.toContain('b');
    expect(posts.map(p => p.date)).not.toContain('2026-11-13');
  });
});

describe('pictures', () => {
  it('rotates away from an image Instagram showed in the last four weeks', () => {
    const posts = plan({
      settings: settings({ artistPhoto: { instagramOk: true }, uploadIds: ['u1'] }),
      releases: [rel('a', '2024-03-01')],
    });
    expect(posts.map(p => [p.imageKey, p.imageOnInstagram])).toEqual([['cover:a', true], ['photo', true]]);
  });

  it('only looks back: a Bandcamp Friday later on doesn’t take Instagram away from an earlier post', () => {
    const posts = plan({ releases: [rel('a', '2024-03-01')], bandcampFridays: ['2026-12-04'] });
    expect(summary(posts)[0]).toBe('2026-11-13 catalogue a');
    expect(posts[0]).toMatchObject({ imageKey: 'cover:a', imageOnInstagram: true });
  });

  it('skips Instagram when nothing fresh is left, but the other networks still get the cover', () => {
    const posts = plan({ releases: [rel('a', '2024-03-01')] });
    expect(posts.map(p => [p.imageKey, p.imageOnInstagram])).toEqual([['cover:a', true], ['cover:a', false]]);
  });

  it('a call for support uses the photo or an upload, never a release’s cover', () => {
    const many = Array.from({ length: 20 }, (_, i) => rel(`r${i}`, `20${10 + i}-01-01`));
    const posts = plan({ settings: settings({ postsPerWeek: 3, artistPhoto: { instagramOk: true } }), releases: many });
    const support = posts.filter(p => p.kind === 'support');
    expect(support.length).toBeGreaterThan(1);
    for (const p of support) expect(p.imageKey).toBe('photo');
    // Shown on Instagram once in any four weeks; otherwise it goes to the other networks only.
    expect(support.filter(p => p.imageOnInstagram).length).toBeLessThan(support.length);
  });

  it('never offers Instagram a photo outside its shape range', () => {
    const posts = plan({ settings: settings({ artistPhoto: { instagramOk: false } }), releases: [rel('a', '2024-03-01')] });
    expect(posts[1]).toMatchObject({ imageKey: 'cover:a', imageOnInstagram: false });
  });
});

describe('determinism', () => {
  it('gives the same plan for the same inputs', () => {
    const input = { settings: settings({ postsPerWeek: 3 }), releases: fourReleases, bandcampFridays: ['2026-11-13'] };
    expect(plan(input)).toEqual(plan(input));
  });

  it('never reads the clock or randomness', () => {
    const source = readFileSync(join(__dirname, '..', 'autopost-plan.ts'), 'utf8')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    expect(source).not.toMatch(/Date\.now\(|Math\.random\(|new Date\(\)/);
  });
});
