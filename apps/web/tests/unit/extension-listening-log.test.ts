// The extension's on-device play counts. What counts as a play, what's kept, and what isn't: the
// privacy policy describes this log, so the tests pin its shape as much as its arithmetic.

import { describe, it, expect } from 'vitest';
import {
  addToLog,
  emptyLog,
  emptyTrackState,
  isPlayCountingOn,
  monthKey,
  playbackStopped,
  pruneLog,
  trackStarted,
  yearTotals,
  MAX_ARTISTS_PER_MONTH,
  MAX_MONTHS,
  MIN_PLAY_MS,
  REPEAT_GUARD_MS,
} from '../../../../apps/extension/lib/listening-log.js';

// Local-time dates, because months are the listener's own.
const T0 = new Date(2026, 11, 3, 20, 0, 0).getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe('isPlayCountingOn', () => {
  it('is on unless switched off', () => {
    expect(isPlayCountingOn(undefined)).toBe(true);
    expect(isPlayCountingOn(true)).toBe(true);
    expect(isPlayCountingOn(false)).toBe(false);
  });
});

describe('addToLog', () => {
  it('counts plays and clicks per artist per month, keyed case-insensitively', () => {
    let log = addToLog(undefined, 'Wednesday', 'plays', T0);
    log = addToLog(log, '  wednesday ', 'plays', T0);
    log = addToLog(log, 'Wednesday', 'clicks', T0);

    expect(log).toEqual({
      v: 1,
      months: { '2026-12': { wednesday: { name: 'Wednesday', plays: 2, clicks: 1 } } },
    });
  });

  it('keeps nothing but a name and two counts', () => {
    const log = addToLog(undefined, 'Wednesday', 'plays', T0);
    expect(Object.keys(log.months['2026-12'].wednesday).sort()).toEqual(['clicks', 'name', 'plays']);
  });

  it('ignores a blank artist', () => {
    expect(addToLog(undefined, '   ', 'plays', T0)).toEqual(emptyLog());
  });

  it('starts over from a stored value it does not recognise', () => {
    const log = addToLog({ something: 'else' } as never, 'Wednesday', 'plays', T0);
    expect(log.months['2026-12'].wednesday.plays).toBe(1);
  });

  it('drops months older than the retention window', () => {
    const old = new Date(2024, 11, 15).getTime();
    const log = addToLog(addToLog(undefined, 'Old Artist', 'plays', old), 'Wednesday', 'plays', T0);
    expect(Object.keys(log.months)).toEqual(['2026-12']);
    expect(MAX_MONTHS).toBe(24);
  });

  it('keeps the most-heard artists when a month is full', () => {
    const months: Record<string, { name: string; plays: number; clicks: number }> = {};
    for (let i = 0; i < MAX_ARTISTS_PER_MONTH; i++) {
      months[`artist ${i}`] = { name: `Artist ${i}`, plays: 5, clicks: 0 };
    }
    const full = { v: 1 as const, months: { '2026-12': months } };
    const log = addToLog(full, 'Newcomer', 'plays', T0);
    const entries = log.months['2026-12'];
    expect(Object.keys(entries)).toHaveLength(MAX_ARTISTS_PER_MONTH);
    expect(entries.newcomer).toBeUndefined();
  });
});

describe('pruneLog', () => {
  it('keeps exactly the last 24 months', () => {
    const log = {
      v: 1 as const,
      months: {
        '2025-01': {},
        '2024-12': {},
        '2026-12': {},
      },
    };
    expect(Object.keys(pruneLog(log, T0).months).sort()).toEqual(['2025-01', '2026-12']);
  });
});

describe('monthKey', () => {
  it('pads the month', () => {
    expect(monthKey(new Date(2027, 0, 1).getTime())).toBe('2027-01');
  });
});

describe('yearTotals', () => {
  it('adds up one calendar year and counts each artist once', () => {
    let log = addToLog(undefined, 'Wednesday', 'plays', new Date(2026, 10, 30).getTime());
    log = addToLog(log, 'Wednesday', 'plays', T0);
    log = addToLog(log, 'Ratboys', 'clicks', T0);
    log = addToLog(log, 'Lomelda', 'plays', new Date(2025, 5, 1).getTime());

    expect(yearTotals(log, 2026)).toEqual({ plays: 2, clicks: 1, artists: 2 });
    expect(yearTotals(undefined, 2026)).toEqual({ plays: 0, clicks: 0, artists: 0 });
  });
});

describe('what counts as a play', () => {
  it('counts a track once the next one starts, if it played for 30 seconds', () => {
    let step = trackStarted(emptyTrackState(), 'Wednesday', 'Bull Believer', T0);
    expect(step.countedArtist).toBeNull();

    step = trackStarted(step.state, 'Wednesday', 'Chosen to Deserve', T0 + MIN_PLAY_MS);
    expect(step.countedArtist).toBe('Wednesday');
  });

  it('does not count a skipped track', () => {
    let step = trackStarted(emptyTrackState(), 'Wednesday', 'Bull Believer', T0);
    step = trackStarted(step.state, 'Ratboys', 'Morning Zoo', T0 + MIN_PLAY_MS - SECOND);
    expect(step.countedArtist).toBeNull();
  });

  it('counts a track when playback stops', () => {
    const started = trackStarted(emptyTrackState(), 'Wednesday', 'Bull Believer', T0);
    const stopped = playbackStopped(started.state, T0 + MINUTE);
    expect(stopped.countedArtist).toBe('Wednesday');
    expect(stopped.state.current).toBeNull();
  });

  it('ignores the same track reported again', () => {
    const started = trackStarted(emptyTrackState(), 'Wednesday', 'Bull Believer', T0);
    const again = trackStarted(started.state, 'Wednesday', 'Bull Believer', T0 + MINUTE);
    expect(again.countedArtist).toBeNull();
    expect(again.state).toBe(started.state);
  });

  it('counts a paused and resumed track once', () => {
    let step = trackStarted(emptyTrackState(), 'Wednesday', 'Bull Believer', T0);
    step = playbackStopped(step.state, T0 + MINUTE);
    expect(step.countedArtist).toBe('Wednesday');

    step = trackStarted(step.state, 'Wednesday', 'Bull Believer', T0 + 2 * MINUTE);
    step = trackStarted(step.state, 'Wednesday', 'Chosen to Deserve', T0 + 5 * MINUTE);
    expect(step.countedArtist).toBeNull();
  });

  it('counts the same track again once the repeat guard has passed', () => {
    let step = trackStarted(emptyTrackState(), 'Wednesday', 'Bull Believer', T0);
    step = playbackStopped(step.state, T0 + MINUTE);
    step = trackStarted(step.state, 'Wednesday', 'Bull Believer', T0 + MINUTE + REPEAT_GUARD_MS);
    step = playbackStopped(step.state, T0 + 2 * MINUTE + REPEAT_GUARD_MS);
    expect(step.countedArtist).toBe('Wednesday');
  });

  it('treats a stop with nothing playing as nothing', () => {
    expect(playbackStopped(undefined, T0)).toEqual({ state: emptyTrackState(), countedArtist: null });
  });
});
