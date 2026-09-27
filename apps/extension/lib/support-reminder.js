// When the popup shows its "consider supporting Unstream" callout.
//
// The rules exist to keep the ask occasional and easy to ignore:
// - Never in someone's first two weeks. Ask only once Unstream has had a chance to be useful.
// - Once it appears, it stays for three days of popup opens, then goes quiet for 60 days
//   whether or not anyone touched it.
// - "Not now" or opening Ko-fi means 60 days of quiet. "I already support Unstream" means a year:
//   Ko-fi doesn't tell us who has given, so people have to tell us themselves.
// - Never on a Bandcamp Friday, when the whole point is buying from artists.
//
// The popup also shows it only in the idle state, never beside an artist's links: the artist
// comes first. State lives in chrome.storage.local and never leaves the device.

const DAY = 24 * 60 * 60 * 1000;

export const SUPPORT_REMINDER_KEY = 'supportReminder';
export const FIRST_ASK_DELAY_DAYS = 14;
export const VISIBLE_DAYS = 3;
export const SNOOZE_DAYS = 60;
export const ALREADY_SUPPORT_DAYS = 365;

/**
 * Decide whether to show the callout now. Returns the state to store back, which is the same
 * object when nothing changed.
 *
 * @param {{ nextDueAt?: number, shownAt?: number | null } | undefined} state
 * @param {number} now
 * @param {boolean} bandcampFriday
 * @returns {{ show: boolean, state: { nextDueAt: number, shownAt: number | null } }}
 */
export function supportReminderDecision(state, now, bandcampFriday) {
  // First time we've seen this install, or someone who updated into this feature.
  if (!state || typeof state.nextDueAt !== 'number') {
    return { show: false, state: { nextDueAt: now + FIRST_ASK_DELAY_DAYS * DAY, shownAt: null } };
  }

  // A visible window that has run out: go quiet for the full snooze, counted from when it appeared.
  if (state.shownAt && now - state.shownAt >= VISIBLE_DAYS * DAY) {
    const expired = { nextDueAt: state.shownAt + SNOOZE_DAYS * DAY, shownAt: null };
    return supportReminderDecision(expired, now, bandcampFriday);
  }

  if (bandcampFriday) return { show: false, state };

  if (state.shownAt) return { show: true, state };

  if (now >= state.nextDueAt) {
    return { show: true, state: { nextDueAt: state.nextDueAt, shownAt: now } };
  }
  return { show: false, state };
}

/** State after "Not now", opening Ko-fi, or "I already support Unstream" (pass days). */
export function snoozeSupportReminder(now, days = SNOOZE_DAYS) {
  return { nextDueAt: now + days * DAY, shownAt: null };
}
