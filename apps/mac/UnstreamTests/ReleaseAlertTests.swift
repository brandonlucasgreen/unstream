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

    // MARK: - Stable identity (the iCloud dismissal sync)

    /// `NewRelease.id` was a fresh `UUID()` per device, and the iCloud dismissal sync published
    /// those ids as the dismissed set. Device A dismissed a release and synced UUID X; device B
    /// held the same release under UUID Y; nothing ever matched, so the sync did nothing at all.
    /// These pin the property that makes it work: same release, same id, wherever it's built.

    func testTwoDevicesDeriveTheSameIdForTheSameCatalogRelease() {
        let onOneMac = release()
        let onAnother = release()

        XCTAssertEqual(onOneMac.id, onAnother.id, "A release's id must not depend on where it was built")
    }

    func testCatalogIdComesFromTheReleasePageNotTheDisplayNames() {
        // Same catalogue entry, two spellings of the artist as the server happened to send it.
        let accented = NewRelease(
            artistName: "Sigur Rós",
            releaseName: "Á",
            releaseDate: Date(timeIntervalSince1970: 0),
            releaseUrl: "https://unstream.stream/a/sigur-ros/a",
            platform: "bandcamp"
        )
        let plain = NewRelease(
            artistName: "Sigur Ros",
            releaseName: "A",
            releaseDate: Date(timeIntervalSince1970: 0),
            releaseUrl: "https://unstream.stream/a/sigur-ros/a",
            platform: "bandcamp"
        )

        XCTAssertEqual(accented.id, "release:sigur-ros/a")
        XCTAssertEqual(accented.id, plain.id)
    }

    /// The live-scrape path hands back a *platform* URL, which carries no slugs — so the key
    /// degrades to the artist and title, and says so in its prefix rather than pretending to be
    /// a catalogue key.
    func testScrapedAlertsKeyOnArtistAndTitleInstead() {
        let onBandcamp = NewRelease(
            artistName: "Kid Lightbulbs",
            releaseName: "Infinite Normal",
            releaseDate: Date(timeIntervalSince1970: 0),
            releaseUrl: "https://kidlightbulbs.bandcamp.com/album/infinite-normal",
            platform: "bandcamp"
        )
        let onMirlo = NewRelease(
            artistName: "kid lightbulbs ",
            releaseName: "Infinite Normal",
            releaseDate: Date(timeIntervalSince1970: 0),
            releaseUrl: "https://mirlo.space/kidlightbulbs/release/infinite-normal",
            platform: "mirlo"
        )

        XCTAssertEqual(onBandcamp.id, "name:kid lightbulbs/infinite normal")
        XCTAssertEqual(
            onBandcamp.id, onMirlo.id,
            "Two devices handed different shop URLs for one record must still agree on its id"
        )
    }

    func testAScrapedKeyCanNeverBeMistakenForACatalogKey() {
        let scraped = NewRelease(
            artistName: "a/b",
            releaseName: "c",
            releaseDate: Date(timeIntervalSince1970: 0),
            releaseUrl: "https://example.bandcamp.com/album/c",
            platform: "bandcamp"
        )

        XCTAssertTrue(scraped.id.hasPrefix("name:"), scraped.id)
        XCTAssertFalse(scraped.id.hasPrefix("release:"), scraped.id)
    }

    /// The id is also the SwiftUI `ForEach` key, so two live alerts must never share one.
    func testTwoReleasesByOneArtistHaveDifferentIds() {
        var state = ReleaseCheckState()
        let found = ReleaseAlertManager.selectUnseen(
            [result("First Record"), result("Second Record")], artistName: "Someone", state: &state
        )

        XCTAssertEqual(Set(found.map(\.id)).count, 2)
    }

    /// A v3.4.0 build persisted a random UUID under `id`. Reading it back would keep that device
    /// pinned to an identity no other device shares, so decoding recomputes instead.
    func testDecodingRecomputesTheIdRatherThanTrustingAStoredUUID() throws {
        let stored = UUID().uuidString
        let legacy = """
        {
          "id": "\(stored)",
          "artistName": "Kid Lightbulbs",
          "releaseName": "Infinite Normal",
          "releaseDate": 750000000,
          "releaseUrl": "https://unstream.stream/a/kid-lightbulbs/infinite-normal",
          "platform": "bandcamp",
          "detectedAt": 750000000
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(NewRelease.self, from: legacy)

        XCTAssertEqual(decoded.id, "release:kid-lightbulbs/infinite-normal")
        XCTAssertNotEqual(decoded.id, stored)
    }

    func testAnAlertSurvivesAnEncodeDecodeRoundTripWithItsIdIntact() throws {
        let original = release()
        let data = try JSONEncoder().encode(original)

        let decoded = try JSONDecoder().decode(NewRelease.self, from: data)

        XCTAssertEqual(decoded.id, original.id)
    }

    // MARK: - Which links get sent (the three-platform gate)

    private func entry(_ platforms: [(String, String)]) -> SupportEntry {
        SupportEntry(
            artistName: "Someone",
            imageUrl: nil,
            platforms: platforms.map { SavedPlatform(sourceId: $0.0, url: $0.1) }
        )
    }

    /// The old client built its platforms dictionary from bandcamp, faircamp and mirlo alone and
    /// then skipped the artist when it came out empty — even though the server answers from the
    /// release catalogue first and never reads the dictionary on that path. Discogs is the
    /// largest link population we have, so this skipped more artists than it covered.
    func testDiscogsOnlyArtistStillGetsTheirLinksSent() {
        let urls = ReleaseAlertManager.platformUrls(for: entry([("discogs", "https://discogs.com/artist/1")]))

        XCTAssertEqual(urls, ["discogs": "https://discogs.com/artist/1"])
    }

    func testEverySavedLinkIsSentNotJustTheScrapableThree() {
        let urls = ReleaseAlertManager.platformUrls(for: entry([
            ("bandcamp", "https://someone.bandcamp.com"),
            ("jamcoop", "https://jam.coop/someone"),
            ("instagram", "https://instagram.com/someone"),
        ]))

        XCTAssertEqual(Set(urls.keys), ["bandcamp", "jamcoop", "instagram"])
    }

    func testBlankUrlsAreDroppedAndTheFirstLinkPerPlatformWins() {
        let urls = ReleaseAlertManager.platformUrls(for: entry([
            ("bandcamp", "https://first.bandcamp.com"),
            ("bandcamp", "https://second.bandcamp.com"),
            ("faircamp", ""),
        ]))

        XCTAssertEqual(urls, ["bandcamp": "https://first.bandcamp.com"])
    }

    // MARK: - How far back to look (the closed laptop)

    private func daysAgo(_ days: Double, from now: Date) -> Date {
        now.addingTimeInterval(-days * 24 * 60 * 60)
    }

    func testFirstEverCheckLetsTheServerChooseTheWindow() {
        XCTAssertNil(ReleaseAlertManager.lookbackDays(since: nil))
    }

    /// The defect: a laptop closed for six weeks woke up, asked for the server's default 31 days,
    /// and permanently lost everything that had aged past that window while it slept.
    func testASixWeekGapAsksForSixWeeksPlusPadding() {
        let now = Date()

        let days = ReleaseAlertManager.lookbackDays(since: daysAgo(42, from: now), now: now)

        XCTAssertEqual(days, 49)
    }

    func testAShortGapStillAsksForTheFullMonthWeUsedToGet() {
        let now = Date()

        XCTAssertEqual(ReleaseAlertManager.lookbackDays(since: daysAgo(1, from: now), now: now), 31)
    }

    func testAVeryOldCheckIsCappedAtTheServersCeiling() {
        let now = Date()

        XCTAssertEqual(ReleaseAlertManager.lookbackDays(since: daysAgo(900, from: now), now: now), 365)
    }

    func testALastCheckDateInTheFutureFallsBackToTheDefault() {
        let now = Date()

        XCTAssertNil(ReleaseAlertManager.lookbackDays(since: now.addingTimeInterval(3600), now: now))
    }
}
