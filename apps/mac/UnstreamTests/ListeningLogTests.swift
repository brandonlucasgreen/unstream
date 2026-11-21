import XCTest
@testable import Unstream

/// The Mac app's on-device play counts. These are the cases
/// `apps/web/tests/unit/extension-listening-log.test.ts` pins for the browser extension; the two
/// suites agreeing is what keeps the clients counting the same way. The privacy policy describes
/// this log, so its shape is pinned as much as its arithmetic.
final class ListeningLogTests: XCTestCase {

    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private func date(_ year: Int, _ month: Int, _ day: Int, hour: Int = 20) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    private var t0: Date { date(2026, 12, 3) }

    // MARK: - The log

    func testCountsPlaysAndClicksPerArtistPerMonthCaseInsensitively() {
        let log = ListeningLog()
            .adding(.plays, for: "Wednesday", at: t0, calendar: calendar)
            .adding(.plays, for: "  wednesday ", at: t0, calendar: calendar)
            .adding(.clicks, for: "Wednesday", at: t0, calendar: calendar)

        XCTAssertEqual(log.months, [
            "2026-12": ["wednesday": .init(name: "Wednesday", plays: 2, clicks: 1)]
        ])
    }

    func testStoresOnlyANameAndTwoCounts() throws {
        let log = ListeningLog().adding(.plays, for: "Wednesday", at: t0, calendar: calendar)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(log)) as? [String: Any]
        let months = json?["months"] as? [String: [String: [String: Any]]]
        XCTAssertEqual(months?["2026-12"]?["wednesday"]?.keys.sorted(), ["clicks", "name", "plays"])
    }

    func testIgnoresABlankArtist() {
        XCTAssertEqual(ListeningLog().adding(.plays, for: "   ", at: t0, calendar: calendar), ListeningLog())
    }

    func testDropsMonthsOlderThanTheRetentionWindow() {
        let log = ListeningLog()
            .adding(.plays, for: "Old Artist", at: date(2024, 12, 15), calendar: calendar)
            .adding(.plays, for: "Wednesday", at: t0, calendar: calendar)
        XCTAssertEqual(Array(log.months.keys), ["2026-12"])
        XCTAssertEqual(ListeningLog.maxMonths, 24)
    }

    func testKeepsExactlyTheLast24Months() {
        var log = ListeningLog()
        log.months = ["2025-01": [:], "2024-12": [:], "2026-12": [:]]
        XCTAssertEqual(log.pruned(now: t0, calendar: calendar).months.keys.sorted(), ["2025-01", "2026-12"])
    }

    func testKeepsTheMostHeardArtistsWhenAMonthIsFull() {
        var entries: [String: ListeningLog.ArtistCounts] = [:]
        for i in 0..<ListeningLog.maxArtistsPerMonth {
            entries["artist \(i)"] = .init(name: "Artist \(i)", plays: 5, clicks: 0)
        }
        var full = ListeningLog()
        full.months = ["2026-12": entries]

        let log = full.adding(.plays, for: "Newcomer", at: t0, calendar: calendar)
        XCTAssertEqual(log.months["2026-12"]?.count, ListeningLog.maxArtistsPerMonth)
        XCTAssertNil(log.months["2026-12"]?["newcomer"])
    }

    func testMonthKeyPadsTheMonth() {
        XCTAssertEqual(ListeningLog.monthKey(date(2027, 1, 1), calendar: calendar), "2027-01")
    }

    func testYearTotalsAddUpOneCalendarYearAndCountEachArtistOnce() {
        let log = ListeningLog()
            .adding(.plays, for: "Wednesday", at: date(2026, 11, 30), calendar: calendar)
            .adding(.plays, for: "Wednesday", at: t0, calendar: calendar)
            .adding(.clicks, for: "Ratboys", at: t0, calendar: calendar)
            .adding(.plays, for: "Lomelda", at: date(2025, 6, 1), calendar: calendar)

        XCTAssertEqual(log.totals(forYear: 2026), .init(plays: 2, clicks: 1, artists: 2))
        XCTAssertEqual(ListeningLog().totals(forYear: 2026), .init())
    }

    // MARK: - What counts as a play

    func testCountsATrackOnceTheNextStartsIfItPlayedFor30Seconds() {
        var step = PlayCounting.trackStarted(PlayTrackState(), artist: "Wednesday", title: "Bull Believer", now: t0)
        XCTAssertNil(step.countedArtist)

        step = PlayCounting.trackStarted(step.state, artist: "Wednesday", title: "Chosen to Deserve", now: t0 + 30)
        XCTAssertEqual(step.countedArtist, "Wednesday")
    }

    func testDoesNotCountASkippedTrack() {
        var step = PlayCounting.trackStarted(PlayTrackState(), artist: "Wednesday", title: "Bull Believer", now: t0)
        step = PlayCounting.trackStarted(step.state, artist: "Ratboys", title: "Morning Zoo", now: t0 + 29)
        XCTAssertNil(step.countedArtist)
    }

    func testCountsATrackWhenPlaybackStops() {
        let started = PlayCounting.trackStarted(PlayTrackState(), artist: "Wednesday", title: "Bull Believer", now: t0)
        let stopped = PlayCounting.playbackStopped(started.state, now: t0 + 60)
        XCTAssertEqual(stopped.countedArtist, "Wednesday")
        XCTAssertNil(stopped.state.current)
    }

    func testIgnoresTheSameTrackPublishedAgain() {
        let started = PlayCounting.trackStarted(PlayTrackState(), artist: "Wednesday", title: "Bull Believer", now: t0)
        let again = PlayCounting.trackStarted(started.state, artist: "Wednesday", title: "Bull Believer", now: t0 + 60)
        XCTAssertNil(again.countedArtist)
        XCTAssertEqual(again.state, started.state)
    }

    func testCountsAPausedAndResumedTrackOnce() {
        var step = PlayCounting.trackStarted(PlayTrackState(), artist: "Wednesday", title: "Bull Believer", now: t0)
        step = PlayCounting.playbackStopped(step.state, now: t0 + 60)
        XCTAssertEqual(step.countedArtist, "Wednesday")

        step = PlayCounting.trackStarted(step.state, artist: "Wednesday", title: "Bull Believer", now: t0 + 120)
        step = PlayCounting.trackStarted(step.state, artist: "Wednesday", title: "Chosen to Deserve", now: t0 + 300)
        XCTAssertNil(step.countedArtist)
    }

    func testCountsTheSameTrackAgainOnceTheRepeatGuardHasPassed() {
        let guardSeconds = PlayCounting.repeatGuardSeconds
        var step = PlayCounting.trackStarted(PlayTrackState(), artist: "Wednesday", title: "Bull Believer", now: t0)
        step = PlayCounting.playbackStopped(step.state, now: t0 + 60)
        step = PlayCounting.trackStarted(step.state, artist: "Wednesday", title: "Bull Believer", now: t0 + 60 + guardSeconds)
        step = PlayCounting.playbackStopped(step.state, now: t0 + 120 + guardSeconds)
        XCTAssertEqual(step.countedArtist, "Wednesday")
    }

    func testAStopWithNothingPlayingIsNothing() {
        let stopped = PlayCounting.playbackStopped(PlayTrackState(), now: t0)
        XCTAssertNil(stopped.countedArtist)
        XCTAssertEqual(stopped.state, PlayTrackState())
    }

    // MARK: - The store

    private func makeStore(enabled: Bool?) -> (PlayCountStore, URL, UserDefaults) {
        let suite = "ListeningLogTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        if let enabled { defaults.set(enabled, forKey: PlayCountStore.enabledKey) }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(suite, isDirectory: true)
            .appendingPathComponent("listening-log.json")
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        return (PlayCountStore(defaults: defaults, fileURL: url), url, defaults)
    }

    func testStoreIsOnByDefaultAndSavesClicksToDisk() {
        let (store, url, defaults) = makeStore(enabled: nil)
        XCTAssertTrue(store.isEnabled)

        store.recordClick(artist: "Wednesday")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))

        let reloaded = PlayCountStore(defaults: defaults, fileURL: url)
        XCTAssertEqual(reloaded.log, store.log)
    }

    func testStoreRecordsNothingWhenOff() {
        let (store, url, _) = makeStore(enabled: false)
        store.recordClick(artist: "Wednesday")
        XCTAssertEqual(store.log, ListeningLog())
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testClearDeletesTheFile() {
        let (store, url, _) = makeStore(enabled: true)
        store.recordClick(artist: "Wednesday")
        store.clear()
        XCTAssertEqual(store.log, ListeningLog())
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
