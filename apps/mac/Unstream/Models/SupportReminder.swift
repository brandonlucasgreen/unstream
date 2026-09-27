#if os(macOS)
import Foundation

/// When the popover shows its "consider supporting Unstream" callout.
///
/// The same rules as the browser extension's `apps/extension/lib/support-reminder.js` — change the
/// two together. They exist to keep the ask occasional and easy to ignore:
/// - Never in someone's first two weeks. Ask only once Unstream has had a chance to be useful.
/// - Once it appears, it stays for a day of popover opens, then goes quiet for 30 days whether or
///   not anyone touched it.
/// - "Not now" or opening Ko-fi means 30 days of quiet. "I already support Unstream" means a year:
///   Ko-fi doesn't tell us who has given, so people have to tell us themselves.
/// - Never on a Bandcamp Friday, when the whole point is buying from artists.
///
/// The popover also shows it only in the empty state, never beside an artist's links. macOS only:
/// the iOS app's idle screen is artist suggestions, and App Review allows only the StoreKit tip jar.
struct SupportReminderState: Equatable {
    var nextDueAt: Date
    var shownAt: Date?
}

enum SupportReminder {
    static let firstAskDelayDays = 14
    static let visibleDays = 1
    static let snoozeDays = 30
    static let alreadySupportDays = 365

    private static let day: TimeInterval = 24 * 60 * 60

    /// Whether to show the callout now, and the state to store back.
    static func decision(
        state: SupportReminderState?,
        now: Date,
        bandcampFriday: Bool
    ) -> (show: Bool, state: SupportReminderState) {
        // First time we've seen this install, or someone who updated into this feature.
        guard let state else {
            let first = SupportReminderState(nextDueAt: now + Double(firstAskDelayDays) * day, shownAt: nil)
            return (false, first)
        }

        // A visible window that has run out: go quiet for the full snooze, counted from when it appeared.
        if let shownAt = state.shownAt, now.timeIntervalSince(shownAt) >= Double(visibleDays) * day {
            let expired = SupportReminderState(nextDueAt: shownAt + Double(snoozeDays) * day, shownAt: nil)
            return decision(state: expired, now: now, bandcampFriday: bandcampFriday)
        }

        if bandcampFriday { return (false, state) }

        if state.shownAt != nil { return (true, state) }

        if now >= state.nextDueAt {
            return (true, SupportReminderState(nextDueAt: state.nextDueAt, shownAt: now))
        }
        return (false, state)
    }

    /// State after "Not now", opening Ko-fi, or "I already support Unstream" (pass `days`).
    static func snoozed(now: Date, days: Int = snoozeDays) -> SupportReminderState {
        SupportReminderState(nextDueAt: now + Double(days) * day, shownAt: nil)
    }
}

/// Keeps the reminder's state in UserDefaults. It never leaves the Mac.
enum SupportReminderStore {
    private static let nextDueKey = "supportReminderNextDueAt"
    private static let shownKey = "supportReminderShownAt"

    /// Decides whether to show the callout on this popover open, and records the outcome.
    static func evaluate(now: Date = Date(), defaults: UserDefaults = .standard) -> Bool {
        let result = SupportReminder.decision(
            state: load(defaults),
            now: now,
            bandcampFriday: isBandcampFriday(now: now)
        )
        save(result.state, defaults)
        return result.show
    }

    static func snooze(days: Int = SupportReminder.snoozeDays, now: Date = Date(), defaults: UserDefaults = .standard) {
        save(SupportReminder.snoozed(now: now, days: days), defaults)
    }

    static func load(_ defaults: UserDefaults) -> SupportReminderState? {
        guard let nextDueAt = defaults.object(forKey: nextDueKey) as? Date else { return nil }
        return SupportReminderState(nextDueAt: nextDueAt, shownAt: defaults.object(forKey: shownKey) as? Date)
    }

    private static func save(_ state: SupportReminderState, _ defaults: UserDefaults) {
        defaults.set(state.nextDueAt, forKey: nextDueKey)
        if let shownAt = state.shownAt {
            defaults.set(shownAt, forKey: shownKey)
        } else {
            defaults.removeObject(forKey: shownKey)
        }
    }
}
#endif
