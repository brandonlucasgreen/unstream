import XCTest
@testable import Unstream

/// When the popover shows its "consider supporting Unstream" callout.
///
/// These are the same cases `apps/web/tests/unit/extension-support-reminder.test.ts` pins for the
/// browser extension. Swift can't be driven from vitest, so the two suites agreeing is what keeps
/// the clients asking on the same schedule. The point of the rules is restraint, so the quiet
/// periods matter as much as the showing.
final class SupportReminderTests: XCTestCase {

    private let day: TimeInterval = 24 * 60 * 60
    private let t0 = Date(timeIntervalSince1970: 1_790_856_000) // 2026-10-01 12:00 UTC

    // The cadence Brandon chose (2026-09-27). Changing it should be a decision, not a side effect.
    func testCadence() {
        XCTAssertEqual(SupportReminder.firstAskDelayDays, 14)
        XCTAssertEqual(SupportReminder.visibleDays, 1)
        XCTAssertEqual(SupportReminder.snoozeDays, 30)
        XCTAssertEqual(SupportReminder.alreadySupportDays, 365)
    }

    func testNeverAsksOnFirstSightAndSchedulesTwoWeeksOut() {
        let result = SupportReminder.decision(state: nil, now: t0, bandcampFriday: false)
        XCTAssertFalse(result.show)
        XCTAssertEqual(result.state, SupportReminderState(nextDueAt: t0 + 14 * day, shownAt: nil))
    }

    func testStaysQuietUntilDue() {
        let stored = SupportReminderState(nextDueAt: t0 + day, shownAt: nil)
        let result = SupportReminder.decision(state: stored, now: t0, bandcampFriday: false)
        XCTAssertFalse(result.show)
        XCTAssertEqual(result.state, stored)
    }

    func testShowsOnceDueAndRecordsWhenItAppeared() {
        let stored = SupportReminderState(nextDueAt: t0, shownAt: nil)
        let result = SupportReminder.decision(state: stored, now: t0 + 1, bandcampFriday: false)
        XCTAssertTrue(result.show)
        XCTAssertEqual(result.state, SupportReminderState(nextDueAt: t0, shownAt: t0 + 1))
    }

    func testKeepsShowingDuringItsVisibleDay() {
        let stored = SupportReminderState(nextDueAt: t0, shownAt: t0)
        let result = SupportReminder.decision(state: stored, now: t0 + day - 1, bandcampFriday: false)
        XCTAssertTrue(result.show)
        XCTAssertEqual(result.state, stored)
    }

    func testGoesQuietForTheFullSnoozeOnceTheDayRunsOutEvenIfIgnored() {
        let stored = SupportReminderState(nextDueAt: t0, shownAt: t0)
        let result = SupportReminder.decision(state: stored, now: t0 + day, bandcampFriday: false)
        XCTAssertFalse(result.show)
        XCTAssertEqual(result.state, SupportReminderState(nextDueAt: t0 + 30 * day, shownAt: nil))
    }

    func testAsksAgainOnFirstOpenAfterALongAbsence() {
        let stored = SupportReminderState(nextDueAt: t0, shownAt: t0)
        let later = t0 + 60 * day
        let result = SupportReminder.decision(state: stored, now: later, bandcampFriday: false)
        XCTAssertTrue(result.show)
        XCTAssertEqual(result.state, SupportReminderState(nextDueAt: t0 + 30 * day, shownAt: later))
    }

    func testNeverOnABandcampFridayAndDoesNotUseUpItsTurn() {
        let stored = SupportReminderState(nextDueAt: t0, shownAt: nil)
        let friday = SupportReminder.decision(state: stored, now: t0 + day, bandcampFriday: true)
        XCTAssertFalse(friday.show)
        XCTAssertEqual(friday.state, stored)
        XCTAssertTrue(SupportReminder.decision(state: friday.state, now: t0 + 2 * day, bandcampFriday: false).show)
    }

    func testNotNowOrKofiMeansThirtyDays() {
        let state = SupportReminder.snoozed(now: t0)
        XCTAssertFalse(SupportReminder.decision(state: state, now: t0 + 30 * day - 1, bandcampFriday: false).show)
        XCTAssertTrue(SupportReminder.decision(state: state, now: t0 + 30 * day, bandcampFriday: false).show)
    }

    func testAlreadySupportMeansAYear() {
        let state = SupportReminder.snoozed(now: t0, days: SupportReminder.alreadySupportDays)
        XCTAssertFalse(SupportReminder.decision(state: state, now: t0 + 364 * day, bandcampFriday: false).show)
        XCTAssertTrue(SupportReminder.decision(state: state, now: t0 + 365 * day, bandcampFriday: false).show)
    }

    /// The store round-trips through UserDefaults, including clearing `shownAt` on a snooze.
    func testStorePersistsAcrossOpens() throws {
        let suite = "SupportReminderTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        // A date that is not a Bandcamp Friday, so the store's own calendar check can't interfere.
        let now = t0
        XCTAssertFalse(SupportReminderStore.evaluate(now: now, defaults: defaults))
        XCTAssertTrue(SupportReminderStore.evaluate(now: now + 14 * day, defaults: defaults))
        XCTAssertTrue(SupportReminderStore.evaluate(now: now + 14 * day + 60, defaults: defaults))

        SupportReminderStore.snooze(now: now + 14 * day + 120, defaults: defaults)
        XCTAssertNil(SupportReminderStore.load(defaults)?.shownAt)
        XCTAssertFalse(SupportReminderStore.evaluate(now: now + 15 * day, defaults: defaults))
    }
}
