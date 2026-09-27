// When the extension popup shows its occasional "consider supporting Unstream" callout. The point
// of these rules is restraint, so the tests pin the quiet periods as much as the showing.

import { describe, it, expect } from 'vitest';
import {
  supportReminderDecision,
  snoozeSupportReminder,
  FIRST_ASK_DELAY_DAYS,
  VISIBLE_DAYS,
  SNOOZE_DAYS,
  ALREADY_SUPPORT_DAYS,
} from '../../../../apps/extension/lib/support-reminder.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12);

// The cadence Brandon chose (2026-09-27). Changing it should be a decision, not a side effect.
describe('support reminder cadence', () => {
  it('waits two weeks, shows for a day, then 30 days of quiet; a year for existing supporters', () => {
    expect(FIRST_ASK_DELAY_DAYS).toBe(14);
    expect(VISIBLE_DAYS).toBe(1);
    expect(SNOOZE_DAYS).toBe(30);
    expect(ALREADY_SUPPORT_DAYS).toBe(365);
  });
});

describe('supportReminderDecision', () => {
  it('never asks on first sight, and schedules the first ask two weeks out', () => {
    const { show, state } = supportReminderDecision(undefined, T0, false);
    expect(show).toBe(false);
    expect(state).toEqual({ nextDueAt: T0 + FIRST_ASK_DELAY_DAYS * DAY, shownAt: null });
  });

  it('stays quiet until the due date', () => {
    const stored = { nextDueAt: T0 + DAY, shownAt: null };
    const { show, state } = supportReminderDecision(stored, T0, false);
    expect(show).toBe(false);
    expect(state).toBe(stored);
  });

  it('shows once due, and records when it appeared', () => {
    const stored = { nextDueAt: T0, shownAt: null };
    const { show, state } = supportReminderDecision(stored, T0 + 1000, false);
    expect(show).toBe(true);
    expect(state).toEqual({ nextDueAt: T0, shownAt: T0 + 1000 });
  });

  it('keeps showing during its visible window without changing state', () => {
    const stored = { nextDueAt: T0, shownAt: T0 };
    const { show, state } = supportReminderDecision(stored, T0 + (VISIBLE_DAYS * DAY - 1), false);
    expect(show).toBe(true);
    expect(state).toBe(stored);
  });

  it('goes quiet for the full snooze once the window runs out, even if ignored', () => {
    const stored = { nextDueAt: T0, shownAt: T0 };
    const { show, state } = supportReminderDecision(stored, T0 + VISIBLE_DAYS * DAY, false);
    expect(show).toBe(false);
    expect(state).toEqual({ nextDueAt: T0 + SNOOZE_DAYS * DAY, shownAt: null });
  });

  it('asks again on the first open after a long absence rather than skipping it', () => {
    const stored = { nextDueAt: T0, shownAt: T0 };
    const later = T0 + (SNOOZE_DAYS + 30) * DAY;
    const { show, state } = supportReminderDecision(stored, later, false);
    expect(show).toBe(true);
    expect(state).toEqual({ nextDueAt: T0 + SNOOZE_DAYS * DAY, shownAt: later });
  });

  it('never shows on a Bandcamp Friday, and does not use up its turn', () => {
    const stored = { nextDueAt: T0, shownAt: null };
    const { show, state } = supportReminderDecision(stored, T0 + DAY, true);
    expect(show).toBe(false);
    expect(state).toBe(stored);
    expect(supportReminderDecision(state, T0 + 2 * DAY, false).show).toBe(true);
  });

  it('treats malformed stored state as first sight', () => {
    const { show, state } = supportReminderDecision({ nextDueAt: 'soon' } as never, T0, false);
    expect(show).toBe(false);
    expect(state.nextDueAt).toBe(T0 + FIRST_ASK_DELAY_DAYS * DAY);
  });
});

describe('snoozeSupportReminder', () => {
  it('"Not now" or opening Ko-fi means 30 days of quiet', () => {
    const state = snoozeSupportReminder(T0);
    expect(state).toEqual({ nextDueAt: T0 + SNOOZE_DAYS * DAY, shownAt: null });
    expect(supportReminderDecision(state, T0 + (SNOOZE_DAYS * DAY - 1), false).show).toBe(false);
    expect(supportReminderDecision(state, T0 + SNOOZE_DAYS * DAY, false).show).toBe(true);
  });

  it('"I already support Unstream" means a year', () => {
    const state = snoozeSupportReminder(T0, ALREADY_SUPPORT_DAYS);
    expect(supportReminderDecision(state, T0 + 364 * DAY, false).show).toBe(false);
    expect(supportReminderDecision(state, T0 + 365 * DAY, false).show).toBe(true);
  });
});
