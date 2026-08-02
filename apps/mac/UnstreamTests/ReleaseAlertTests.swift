import XCTest
@testable import Unstream

/// Release alerts: the dedup rule, and the notification body.
///
/// The dedup tests exist because of a bug that lost data permanently rather than merely
/// displaying it wrong (spec §5 defect 1). `ReleaseAlertManager` had two layers of dedup:
/// the inner one, in `checkViaAPI`, correctly matched on release name and recorded the release
/// as known; the outer one then asked whether the display list already held *any* release by
/// that artist and dropped the release if it did. So an artist with an unread alert who put out
/// a second record had that second record dropped from the list and the notification while
/// already being marked known — making it undetectable on every future check.
///
/// `ReleaseCheckState` is the piece that decides "have we seen this before", so that is what
/// these exercise directly.
final class ReleaseAlertTests: XCTestCase {

    private func known(_ name: String, platform: String = "bandcamp") -> KnownRelease {
        KnownRelease(releaseName: name, releaseDate: Date(timeIntervalSince1970: 0), platform: platform)
    }

    // MARK: - Dedup identity

    func testSecondReleaseFromSameArtistIsNotAlreadyKnown() {
        var state = ReleaseCheckState()
        state.addKnownRelease(known("First Record"), for: "Someone")

        // The exact case the old outer dedup got wrong: same artist, different record.
        XCTAssertTrue(state.isKnownReleaseByName("First Record", for: "Someone"))
        XCTAssertFalse(
            state.isKnownReleaseByName("Second Record", for: "Someone"),
            "A different release by a known artist must not count as already seen"
        )
    }

    func testSameReleaseOnAnotherPlatformIsAlreadyKnown() {
        var state = ReleaseCheckState()
        state.addKnownRelease(known("Infinite Normal", platform: "bandcamp"), for: "Kid Lightbulbs")

        // One record on two platforms is one alert, not two.
        XCTAssertTrue(state.isKnownReleaseByName("Infinite Normal", for: "Kid Lightbulbs"))
    }

    func testKnownReleasesAreScopedToTheArtist() {
        var state = ReleaseCheckState()
        state.addKnownRelease(known("Greatest Hits"), for: "Artist A")

        XCTAssertFalse(
            state.isKnownReleaseByName("Greatest Hits", for: "Artist B"),
            "Two artists can release records with the same title"
        )
    }

    func testArtistMatchingIsCaseInsensitive() {
        var state = ReleaseCheckState()
        state.addKnownRelease(known("A Record"), for: "Sigur Rós")

        XCTAssertTrue(state.isKnownReleaseByName("a record", for: "sigur rós"))
    }

    func testAddingTheSameReleaseTwiceDoesNotDuplicateIt() {
        var state = ReleaseCheckState()
        state.addKnownRelease(known("A Record"), for: "Someone")
        state.addKnownRelease(known("A Record"), for: "Someone")

        XCTAssertEqual(state.releases(for: "Someone").count, 1)
    }

    // MARK: - The defect itself, across two checks

    private func result(_ name: String, platform: String = "bandcamp") -> ReleaseCheckResult {
        ReleaseCheckResult(
            releaseName: name,
            releaseDate: Date(timeIntervalSince1970: 1_756_684_800),
            releaseUrl: "https://unstream.stream/a/someone/\(name.lowercased().replacingOccurrences(of: " ", with: "-"))",
            platform: platform
        )
    }

    /// The regression test for spec §5 defect 1, replayed as it actually happened: a first check
    /// finds one record and the fan never opens the alert, then a second check finds a second
    /// record while the first is still unread.
    ///
    /// Under the old code the second record was dropped — the outer dedup saw "this artist
    /// already has an unread alert" — *after* `checkViaAPI` had already written it to
    /// `knownReleases`. So it never appeared and could never be found again.
    func testSecondReleaseSurvivesWhileTheFirstIsStillUnread() {
        var state = ReleaseCheckState()

        let firstCheck = ReleaseAlertManager.selectUnseen(
            [result("First Record")], artistName: "Someone", state: &state
        )
        XCTAssertEqual(firstCheck.map(\.releaseName), ["First Record"])

        // The fan hasn't dismissed it; it's still sitting in the display list.
        let secondCheck = ReleaseAlertManager.selectUnseen(
            [result("Second Record"), result("First Record")], artistName: "Someone", state: &state
        )

        XCTAssertEqual(
            secondCheck.map(\.releaseName),
            ["Second Record"],
            "The new record must come through, and the already-seen one must not repeat"
        )
    }

    func testTwoNewReleasesInOneCheckBothComeThrough() {
        var state = ReleaseCheckState()

        let found = ReleaseAlertManager.selectUnseen(
            [result("A"), result("B")], artistName: "Someone", state: &state
        )

        XCTAssertEqual(found.map(\.releaseName), ["A", "B"])
    }

    func testTheSameRecordOnTwoPlatformsIsOneAlert() {
        var state = ReleaseCheckState()

        let found = ReleaseAlertManager.selectUnseen(
            [result("Infinite Normal", platform: "bandcamp"), result("Infinite Normal", platform: "mirlo")],
            artistName: "Kid Lightbulbs",
            state: &state
        )

        XCTAssertEqual(found.count, 1)
    }

    func testRecheckingWithNothingNewReturnsNothing() {
        var state = ReleaseCheckState()
        _ = ReleaseAlertManager.selectUnseen([result("A")], artistName: "Someone", state: &state)

        let again = ReleaseAlertManager.selectUnseen([result("A")], artistName: "Someone", state: &state)

        XCTAssertTrue(again.isEmpty)
    }

    func testCarriesTheCatalogFieldsOntoTheAlert() {
        var state = ReleaseCheckState()
        let rich = ReleaseCheckResult(
            releaseName: "Infinite Normal",
            releaseDate: Date(timeIntervalSince1970: 1_756_684_800),
            releaseUrl: "https://unstream.stream/a/kid-lightbulbs/infinite-normal",
            platform: "bandcamp",
            platforms: ["bandcamp", "mirlo"],
            status: "announced",
            offerSummary: "from $8 · ≈$6.80 to artist"
        )

        let found = ReleaseAlertManager.selectUnseen([rich], artistName: "Kid Lightbulbs", state: &state)

        XCTAssertEqual(found.first?.platforms, ["bandcamp", "mirlo"])
        XCTAssertEqual(found.first?.offerSummary, "from $8 · ≈$6.80 to artist")
        XCTAssertTrue(found.first?.isUpcoming ?? false)
    }

    // MARK: - Notification body (defect 7)

    private func release(
        name: String = "Infinite Normal",
        platform: String = "bandcamp",
        platforms: [String] = [],
        status: String = "released",
        offerSummary: String = "",
        date: Date = Date(timeIntervalSince1970: 1_756_684_800) // 2025-09-01
    ) -> NewRelease {
        NewRelease(
            artistName: "Kid Lightbulbs",
            releaseName: name,
            releaseDate: date,
            releaseUrl: "https://unstream.stream/a/kid-lightbulbs/infinite-normal",
            platform: platform,
            platforms: platforms,
            status: status,
            offerSummary: offerSummary
        )
    }

    func testBodyNamesEveryPlatformAndThePrice() {
        let body = ReleaseAlertManager.notificationBody(
            for: release(platforms: ["bandcamp", "mirlo"], offerSummary: "from $8 · ≈$6.80 to artist")
        )

        XCTAssertTrue(body.contains("Bandcamp and Mirlo"), body)
        XCTAssertTrue(body.contains("from $8"), body)
        XCTAssertTrue(body.contains("to artist"), body)
    }

    func testBodyOmitsThePriceClauseRatherThanInventingOne() {
        let body = ReleaseAlertManager.notificationBody(for: release(offerSummary: ""))

        XCTAssertEqual(body, "\"Infinite Normal\" — out now on Bandcamp")
        XCTAssertFalse(body.contains("·"), "No trailing separator when there is no price")
    }

    func testUpcomingReleaseReadsAsAnnouncedNotOutNow() {
        let body = ReleaseAlertManager.notificationBody(for: release(status: "announced"))

        XCTAssertTrue(body.contains("announced"), body)
        XCTAssertFalse(body.contains("out now"), body)
    }

    func testPlatformNamesUseTheCatalogNotCapitalization() {
        // `.capitalized` renders these "Jamcoop" and "Kofi".
        let body = ReleaseAlertManager.notificationBody(for: release(platform: "jamcoop", platforms: ["jamcoop"]))

        XCTAssertTrue(body.contains("Jam.coop"), body)
        XCTAssertFalse(body.contains("Jamcoop"), body)
    }

    func testLongPlatformListIsSummarized() {
        let body = ReleaseAlertManager.notificationBody(
            for: release(platforms: ["bandcamp", "mirlo", "jamcoop", "discogs"])
        )

        XCTAssertTrue(body.contains("Bandcamp, Mirlo and 2 more"), body)
    }

    // MARK: - Persistence compatibility

    /// Alerts stored by an earlier build have none of the three fields added alongside the
    /// catalog rewiring. Decoding must fill them in rather than throwing, which would discard a
    /// fan's whole stored alert list on upgrade.
    func testDecodesAnAlertPersistedByAnOlderBuild() throws {
        let legacy = """
        {
          "id": "\(UUID().uuidString)",
          "artistName": "Kid Lightbulbs",
          "releaseName": "Infinite Normal",
          "releaseDate": 750000000,
          "releaseUrl": "https://kidlightbulbs.bandcamp.com/album/infinite-normal",
          "platform": "bandcamp",
          "detectedAt": 750000000
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(NewRelease.self, from: legacy)

        XCTAssertEqual(decoded.releaseName, "Infinite Normal")
        XCTAssertEqual(decoded.platforms, ["bandcamp"])
        XCTAssertEqual(decoded.status, "released")
        XCTAssertEqual(decoded.offerSummary, "")
        XCTAssertFalse(decoded.isUpcoming)
    }
}
