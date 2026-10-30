// Where each autopost post stands on the Promote page (api/functions/autopost-schedule-view.ts):
// which of the plan, the stored slots and Buffer wins, and where "Coming up" ends and "Recent" begins.

import { describe, it, expect } from 'vitest';
import { buildScheduleView } from '../autopost-schedule-view';
import type { PlannedPost } from '../autopost-plan';
import type { StoredSlot } from '../release-autopost-db';
import type { BufferPostState } from '../buffer-client';

const planned = (date: string, extra: Partial<PlannedPost> = {}): PlannedPost => ({
  at: `${date}T04:00:00.000Z`, date, kind: 'catalogue', releaseId: 'r1', templateIndex: 0,
  imageKey: 'cover:r1', imageOnInstagram: true, ...extra,
});

const stored = (date: string, extra: Partial<StoredSlot> = {}): StoredSlot => ({
  slotAt: `${date}T04:00:00.000Z`, slotDate: date, kind: 'catalogue', releaseId: 'r1', templateIndex: 0,
  imageKey: 'cover:r1', imageOnInstagram: true, status: 'pushed', attempts: 1, error: null,
  bufferPostIds: [{ channelId: 'ig', postId: 'p_ig' }, { channelId: 'th', postId: 'p_th' }],
  captions: {
    ig: { service: 'instagram', text: 'link in bio', imageUrl: 'https://cards.unstream.stream/a.jpg' },
    th: { service: 'threads', text: 'with a link', imageUrl: 'https://cards.unstream.stream/a.jpg' },
  },
  ...extra,
});

const live = (posts: Partial<BufferPostState>[]) =>
  new Map(posts.map(p => [p.id!, { channelId: '', status: 'scheduled', dueAt: null, sentAt: null, externalLink: null, error: null, ...p } as BufferPostState]));

const base = { today: '2026-10-30', pushAheadHours: 72, maxAttempts: 3 };

describe('buildScheduleView', () => {
  it('shows a planned post as not in Buffer yet, with when it goes there', () => {
    const { upcoming } = buildScheduleView({ ...base, plan: [planned('2026-11-04')], stored: [], live: null });
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].state).toEqual({ is: 'planned', toBufferAt: '2026-11-01T04:00:00.000Z', lastError: null });
  });

  it('gives each channel of a post in Buffer Buffer’s own status', () => {
    const { upcoming } = buildScheduleView({
      ...base,
      plan: [],
      stored: [stored('2026-10-30', { error: 'bluesky: too long' })],
      live: live([
        { id: 'p_ig', status: 'scheduled', dueAt: '2026-10-31T00:03:00.000Z' },
        { id: 'p_th', status: 'sent', externalLink: 'https://threads.net/x' },
      ]),
    });
    expect(upcoming[0].state).toEqual({
      is: 'in_buffer',
      skipped: 'bluesky: too long',
      channels: [
        { channelId: 'ig', service: 'instagram', status: 'scheduled', dueAt: '2026-10-31T00:03:00.000Z', link: null, error: null },
        { channelId: 'th', service: 'threads', status: 'sent', dueAt: null, link: 'https://threads.net/x', error: null },
      ],
    });
    expect(upcoming[0].captions).toEqual(stored('2026-10-30').captions);
  });

  it('tells a post Buffer no longer has from one Buffer couldn’t be asked about', () => {
    const missing = buildScheduleView({ ...base, plan: [], stored: [stored('2026-10-30')], live: live([]) });
    const unknown = buildScheduleView({ ...base, plan: [], stored: [stored('2026-10-30')], live: null });
    expect(missing.upcoming[0].state).toMatchObject({ channels: [{ status: 'missing' }, { status: 'missing' }] });
    expect(unknown.upcoming[0].state).toMatchObject({ channels: [{ status: 'unknown' }, { status: 'unknown' }] });
  });

  it('shows a failed slot the sweep will retry as planned, with why the last try failed', () => {
    const { upcoming } = buildScheduleView({
      ...base,
      plan: [planned('2026-11-01')],
      stored: [stored('2026-11-01', { status: 'failed', attempts: 2, error: 'Buffer 503', bufferPostIds: [], captions: {} })],
      live: null,
    });
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].state).toEqual({ is: 'planned', toBufferAt: '2026-10-29T04:00:00.000Z', lastError: 'Buffer 503' });
  });

  it('shows a slot out of tries as failed, not as planned again', () => {
    const { upcoming } = buildScheduleView({
      ...base,
      plan: [planned('2026-11-01')],
      stored: [stored('2026-11-01', { status: 'failed', attempts: 3, error: 'Buffer 503', bufferPostIds: [], captions: {} })],
      live: null,
    });
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].state).toEqual({ is: 'failed', error: 'Buffer 503' });
  });

  it('shows a slot a run is handing over as sending', () => {
    const { upcoming } = buildScheduleView({ ...base, plan: [], stored: [stored('2026-11-01', { status: 'pushing' })], live: null });
    expect(upcoming[0].state).toEqual({ is: 'sending' });
    expect(upcoming[0].captions).toBeNull();
  });

  it('puts today and later under Coming up in order, and earlier days under Recent, newest first', () => {
    const view = buildScheduleView({
      ...base,
      plan: [planned('2026-11-06'), planned('2026-11-02')],
      stored: [stored('2026-10-26'), stored('2026-10-28'), stored('2026-10-30')],
      live: null,
    });
    expect(view.upcoming.map(s => s.date)).toEqual(['2026-10-30', '2026-11-02', '2026-11-06']);
    expect(view.recent.map(s => s.date)).toEqual(['2026-10-28', '2026-10-26']);
  });

  it('keeps Recent short', () => {
    const days = Array.from({ length: 14 }, (_, i) => `2026-10-${String(10 + i).padStart(2, '0')}`);
    const { recent } = buildScheduleView({ ...base, plan: [], stored: days.map(d => stored(d)), live: null });
    expect(recent).toHaveLength(10);
    expect(recent[0].date).toBe('2026-10-23');
  });
});
