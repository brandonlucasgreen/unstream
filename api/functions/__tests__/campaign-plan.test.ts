// Release campaigns: what Unstream proposes for a release (campaign-plan.ts). Release day is
// Friday 4 December 2026 throughout, and today is Monday 2 November.

import { describe, it, expect } from 'vitest';
import { MIN_DAYS_APART, proposeCampaign, type ProposalInput } from '../campaign-plan';
import { daysBetween } from '../autopost-plan';
import { renderTemplate, templateProblems } from '../../shared/autopost-templates';
import { CAMPAIGN_STEPS } from '../../shared/campaign-steps';

const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  releaseDate: '2026-12-04',
  startDate: '2026-11-06',
  today: '2026-11-02',
  releaseType: 'album',
  preorderOpen: true,
  onBandcamp: true,
  bandcampFridays: ['2026-12-04', '2027-01-01'],
  images: { hasCover: true, hasPhoto: true, uploadIds: [] },
  ...over,
});

const steps = (posts: ReturnType<typeof proposeCampaign>) => posts.map(p => `${p.date} ${p.step}`);

describe('the timeline', () => {
  it('lays out a four-week campaign around release day', () => {
    expect(steps(proposeCampaign(input()))).toEqual([
      '2026-11-06 announce',
      '2026-11-13 story',
      '2026-11-20 credits',
      '2026-11-27 week_to_go',
      '2026-12-03 tomorrow',
      '2026-12-04 release_day',
      '2026-12-07 thank_you',
      '2026-12-14 icymi',
      '2027-01-01 bandcamp_friday',
    ]);
  });

  it('keeps what matters most on a short runway', () => {
    const posts = proposeCampaign(input({ startDate: '2026-11-26' }));
    expect(steps(posts)).toEqual([
      '2026-11-26 announce',
      '2026-12-03 tomorrow',
      '2026-12-04 release_day',
      '2026-12-07 thank_you',
      '2026-12-14 icymi',
      '2027-01-01 bandcamp_friday',
    ]);
  });

  it('never posts two days running, except the day before release and release day', () => {
    for (const start of ['2026-11-03', '2026-11-12', '2026-11-19', '2026-11-25', '2026-11-28', '2026-12-02']) {
      const posts = proposeCampaign(input({ startDate: start }));
      for (let i = 1; i < posts.length; i++) {
        const gap = daysBetween(posts[i - 1].date, posts[i].date);
        if (posts[i - 1].step === 'tomorrow' && posts[i].step === 'release_day') expect(gap).toBe(1);
        else expect(gap).toBeGreaterThanOrEqual(MIN_DAYS_APART);
      }
    }
  });

  it('never proposes a post before tomorrow', () => {
    const posts = proposeCampaign(input({ startDate: '2026-10-01', releaseDate: '2026-11-06' }));
    expect(posts[0].date >= '2026-11-03').toBe(true);
  });

  it('once it’s out, runs from tomorrow for the weeks chosen, with no countdown', () => {
    const posts = proposeCampaign(input({ releaseDate: '2026-10-30', preorderOpen: false }));
    expect(steps(posts)).toEqual([
      '2026-11-03 out_now',
      '2026-11-10 story',
      '2026-11-17 credits',
      '2026-11-23 thank_you',
      '2026-11-30 icymi',
    ]);
  });

  it('once it’s out, takes a Bandcamp Friday inside the run in place of a step too close to it', () => {
    const posts = proposeCampaign(input({
      releaseDate: '2026-10-30', releaseType: 'single', runWeeks: 2, bandcampFridays: ['2026-11-06'], preorderOpen: false,
    }));
    expect(steps(posts)).toEqual([
      '2026-11-03 out_now',
      '2026-11-06 bandcamp_friday',
      '2026-11-12 thank_you',
      '2026-11-16 icymi',
    ]);
  });

  it('treats release day today as already out', () => {
    expect(proposeCampaign(input({ releaseDate: '2026-11-02' }))[0]).toMatchObject({ step: 'out_now', date: '2026-11-03' });
  });

  it('thanks the people on it only for an album or EP', () => {
    expect(proposeCampaign(input({ releaseType: 'single' })).map(p => p.step)).not.toContain('credits');
  });

  it('includes the first Bandcamp Friday after release only for a release on Bandcamp', () => {
    expect(proposeCampaign(input({ onBandcamp: false })).map(p => p.step)).not.toContain('bandcamp_friday');
    // Release day itself being a Bandcamp Friday is release day's post, not a second one.
    expect(proposeCampaign(input({ bandcampFridays: ['2026-12-04'] })).map(p => p.step)).not.toContain('bandcamp_friday');
  });
});

describe('the drafts', () => {
  it('ask for pre-orders only before release day, while a pre-order is open', () => {
    const posts = proposeCampaign(input());
    expect(posts.find(p => p.step === 'announce')!.text).toMatch(/pre-order/i);
    expect(proposeCampaign(input({ preorderOpen: false })).find(p => p.step === 'announce')!.text).not.toMatch(/pre-order/i);
  });

  it('are valid templates that fill for a release with nothing but a title, date, where and link', () => {
    for (const def of Object.values(CAMPAIGN_STEPS)) {
      for (const draft of [def.draft.preorder, def.draft.out, ...(def.draft.older ? [def.draft.older] : [])]) {
        expect(templateProblems(draft)).toEqual([]);
        expect(renderTemplate(draft, { title: 'Luminaires', date: 'December 4, 2026', where: 'Bandcamp', link: 'https://x' })).not.toBeNull();
        expect(draft).not.toMatch(/\ban? \{type\}/);
      }
    }
  });
});

describe('the drafts for a release already out', () => {
  it('never ask for a pre-order, even if the release still reads as announced', () => {
    const posts = proposeCampaign(input({ releaseDate: '2026-10-30', preorderOpen: true }));
    for (const p of posts) expect(p.text).not.toMatch(/pre-order/i);
  });

  it('stop calling it new once it’s more than six weeks old', () => {
    const recent = proposeCampaign(input({ releaseDate: '2026-10-30', preorderOpen: false }));
    expect(recent[0].text).toContain('my new');
    const old = proposeCampaign(input({ releaseDate: '2025-10-23', preorderOpen: false }));
    for (const p of old) expect(p.text).not.toMatch(/\bnew\b|so far|before it’s out|out now/);
    expect(old.find(p => p.step === 'thank_you')!.text).toContain('{age}');
  });
});

describe('images', () => {
  it('puts the cover on release posts and uploads, then the photo, on personal ones', () => {
    const posts = proposeCampaign(input({ images: { hasCover: true, hasPhoto: true, uploadIds: ['u1', 'u2'] } }));
    const byStep = Object.fromEntries(posts.map(p => [p.step, p.imageKey]));
    expect(byStep).toMatchObject({
      announce: 'cover', story: 'upload:u1', credits: 'upload:u2', tomorrow: 'photo', release_day: 'cover', thank_you: 'upload:u1',
    });
  });

  it('falls back to the cover with nothing personal, and to nothing with nothing at all', () => {
    const cover = proposeCampaign(input({ images: { hasCover: true, hasPhoto: false, uploadIds: [] } }));
    expect(cover.every(p => p.imageKey === 'cover')).toBe(true);
    const none = proposeCampaign(input({ images: { hasCover: false, hasPhoto: false, uploadIds: [] } }));
    expect(none.every(p => p.imageKey === null)).toBe(true);
  });
});
