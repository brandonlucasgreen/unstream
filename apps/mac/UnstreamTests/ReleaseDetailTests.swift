import XCTest
@testable import Unstream

/// The buying guide's formatting rules, and the URL parsing that decides whether a release has
/// a guide at all.
///
/// Every function under test here makes a claim about someone's money or a release date, and the
/// same claims are made by `api/shared/release-display.ts` for the web page at the same URL. The
/// endpoint exists so a native client can never describe a release differently from that page —
/// which only holds if these rules stay pinned. The specific traps are the ones the web page
/// already learned the hard way: a name-your-price release reported as `price: 0`, a payout
/// quoted as a point estimate instead of a range, a year-only date printed as a full one, and a
/// price with cents rendered as "$8.5".
final class ReleaseDetailTests: XCTestCase {

    // MARK: - Money

    func testWholeAmountsHaveNoDecimals() {
        XCTAssertEqual(ReleaseFormatting.money(25, "USD"), "$25")
    }

    func testAmountsWithCentsAlwaysShowTwoDigits() {
        // The trap: letting the formatter pick a minimum renders 8.5 as "$8.5", which reads as
        // a typo in a price.
        XCTAssertEqual(ReleaseFormatting.money(8.5, "USD"), "$8.50")
    }

    func testCentsAreNeverRoundedAway() {
        XCTAssertEqual(ReleaseFormatting.money(12.34, "USD"), "$12.34")
    }

    func testNonDollarCurrenciesKeepTheirOwnSymbol() {
        XCTAssertEqual(ReleaseFormatting.money(20, "EUR"), "€20")
    }

    // MARK: - Price column

    func testZeroMeansNameYourPriceNotFree() {
        // Bandcamp reports name-your-price as `price: 0` with no other signal. Rendering "$0"
        // tells a fan the record costs nothing when they are being asked to decide what to pay.
        XCTAssertEqual(ReleaseFormatting.price(0, "USD"), "Name your price")
    }

    func testMissingPriceIsAnEmDashNotZero() {
        XCTAssertEqual(ReleaseFormatting.price(nil, "USD"), "—")
    }

    func testRealPriceRendersAsMoney() {
        XCTAssertEqual(ReleaseFormatting.price(5, "USD"), "$5")
    }

    // MARK: - Payout

    func testPayoutIsARangeNotAPointEstimate() {
        // Kid Lightbulbs' RUINED CASTLE on Bandcamp: $5 at 80-85%.
        XCTAssertEqual(
            ReleaseFormatting.payout(5, "USD", "80-85%"),
            "≈$4–$4.25 to artist"
        )
    }

    func testASinglePercentageCollapsesToOneFigure() {
        XCTAssertEqual(ReleaseFormatting.payout(10, "USD", "97%"), "≈$9.70 to artist")
    }

    func testApproximatePercentageIsStillHandled() {
        XCTAssertEqual(ReleaseFormatting.payout(10, "USD", "~70%"), "≈$7 to artist")
    }

    func testNoPayoutWithoutAPublishedPercentage() {
        // Discogs: secondhand listings, so the artist genuinely receives nothing. Inventing a
        // figure would be worse than saying nothing.
        XCTAssertNil(ReleaseFormatting.payout(20, "USD", nil))
    }

    func testNoPayoutOnANameYourPriceOffer() {
        // There is no price to take a percentage of, and "≈$0 to artist" would be a lie about
        // the most artist-friendly option on the page.
        XCTAssertNil(ReleaseFormatting.payout(0, "USD", "80-85%"))
    }

    func testNoPayoutWithoutAPrice() {
        XCTAssertNil(ReleaseFormatting.payout(nil, "USD", "80-85%"))
    }

    func testGarbagePercentageProducesNothingRatherThanZero() {
        XCTAssertNil(ReleaseFormatting.payout(20, "USD", "unknown"))
    }

    // MARK: - Dates

    func testYearOnlyDateDoesNotInventAMonthOrDay() {
        // MusicBrainz hands back year-only dates. "1 January 2023" states a fact no source gave.
        XCTAssertEqual(ReleaseFormatting.date("2023-01-01", precision: "year"), "2023")
    }

    func testMonthPrecisionOmitsTheDay() {
        let formatted = ReleaseFormatting.date("2025-10-23", precision: "month")
        XCTAssertTrue(formatted.contains("2025"), "Expected the year in \(formatted)")
        XCTAssertFalse(formatted.contains("23"), "Month precision must not print a day: \(formatted)")
    }

    func testDayPrecisionIncludesTheDay() {
        let formatted = ReleaseFormatting.date("2025-10-23", precision: "day")
        XCTAssertTrue(formatted.contains("23"), "Expected the day in \(formatted)")
        XCTAssertTrue(formatted.contains("2025"), "Expected the year in \(formatted)")
    }

    func testUnknownPrecisionSaysNothingRatherThanPickAShape() {
        // A stored date at 'unknown' precision is one we padded ourselves.
        XCTAssertEqual(ReleaseFormatting.date("2025-01-01", precision: "unknown"), "")
    }

    func testNoDateProducesNoText() {
        XCTAssertEqual(ReleaseFormatting.date(nil, precision: "day"), "")
    }

    // MARK: - Freshness

    func testFreshnessCountsWholeDays() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threeDaysAgo = ISO8601DateFormatter().string(from: now.addingTimeInterval(-3 * 86_400))
        XCTAssertEqual(ReleaseFormatting.freshness(threeDaysAgo, now: now), "Prices checked 3 days ago")
    }

    func testFreshnessCountsElapsedDaysNotCalendarDays() {
        // Whole 24-hour periods, the same arithmetic the web page uses. A calendar-day count
        // would make the same price read "yesterday" in one timezone and "today" in another —
        // and 23h59m is emphatically not yesterday.
        let now = ISO8601DateFormatter().date(from: "2026-08-02T19:10:35Z")!
        let justUnderADay = ISO8601DateFormatter().string(from: now.addingTimeInterval(-86_399))
        let justOverADay = ISO8601DateFormatter().string(from: now.addingTimeInterval(-86_401))

        XCTAssertEqual(ReleaseFormatting.freshness(justUnderADay, now: now), "Prices checked today")
        XCTAssertEqual(ReleaseFormatting.freshness(justOverADay, now: now), "Prices checked yesterday")
    }

    func testFreshnessParsesFractionalSecondTimestamps() {
        // The API sends fractional seconds on captured_at and not on others; a parser that
        // handles only one shape silently drops the freshness line entirely, so the thing this
        // actually guards is "produces anything at all".
        //
        // The `now` here is deliberately well clear of a day boundary. An earlier version used
        // exactly two days later, which is 172,799s once the .933 is counted — one second short,
        // so it correctly read "yesterday" and the test was simply wrong about the code. Don't
        // straddle the boundary in the test that isn't about the boundary; that's what
        // `testFreshnessCountsElapsedDaysNotCalendarDays` above is for.
        let stamp = "2026-08-01T19:10:35.933+00:00"
        let now = ISO8601DateFormatter().date(from: "2026-08-03T20:00:00Z")!

        XCTAssertEqual(ReleaseFormatting.freshness(stamp, now: now), "Prices checked 2 days ago")
        XCTAssertNotEqual(
            ReleaseFormatting.freshness(stamp, now: now), "",
            "A fractional-second timestamp must parse, not fall through to the empty 'never read' case"
        )
    }

    func testFutureTimestampDoesNotProduceNegativeDays() {
        // Clock skew between the server and the device shouldn't render "checked -1 days ago".
        let now = ISO8601DateFormatter().date(from: "2026-08-02T19:10:35Z")!
        let future = ISO8601DateFormatter().string(from: now.addingTimeInterval(3600))
        XCTAssertEqual(ReleaseFormatting.freshness(future, now: now), "Prices checked just now")
    }

    func testNoTimestampMeansNoFreshnessClaim() {
        // Never read means never read — not "checked today".
        XCTAssertEqual(ReleaseFormatting.freshness(nil), "")
    }

    // MARK: - Which alerts have a guide

    func testUnstreamReleaseURLYieldsBothSlugs() {
        let slugs = ReleaseDetailService.slugs(fromReleaseURL: "https://unstream.stream/a/kid-lightbulbs/ruined-castle")
        XCTAssertEqual(slugs?.artist, "kid-lightbulbs")
        XCTAssertEqual(slugs?.release, "ruined-castle")
    }

    func testPlatformURLHasNoGuide() {
        // Alerts from the older scrape path point at one shop. There is no catalogued release
        // behind them, so the app must fall back to opening the link rather than fetching a
        // guide that would 404.
        XCTAssertNil(ReleaseDetailService.slugs(fromReleaseURL: "https://kidlightbulbs.bandcamp.com/album/ruined-castle"))
    }

    func testArtistPageURLHasNoGuide() {
        XCTAssertNil(ReleaseDetailService.slugs(fromReleaseURL: "https://unstream.stream/a/kid-lightbulbs"))
    }

    func testLookalikeHostIsRejected() {
        XCTAssertNil(ReleaseDetailService.slugs(fromReleaseURL: "https://unstream.stream.evil.example/a/x/y"))
    }

    func testGarbageURLIsRejected() {
        XCTAssertNil(ReleaseDetailService.slugs(fromReleaseURL: "not a url"))
    }

    func testAlertCarriesItsGuideTarget() {
        let release = NewRelease(
            artistName: "Kid Lightbulbs",
            releaseName: "RUINED CASTLE",
            releaseDate: Date(timeIntervalSince1970: 0),
            releaseUrl: "https://unstream.stream/a/kid-lightbulbs/ruined-castle",
            platform: "bandcamp"
        )
        let target = release.guideTarget
        XCTAssertEqual(target?.artistSlug, "kid-lightbulbs")
        XCTAssertEqual(target?.releaseSlug, "ruined-castle")
        XCTAssertEqual(target?.releaseTitle, "RUINED CASTLE")
        XCTAssertEqual(target?.artistName, "Kid Lightbulbs")
    }

    // MARK: - Decoding

    /// A real response, trimmed: GET /api/release/kid-lightbulbs/ruined-castle.
    private let responseJSON = """
    {
      "artist": { "slug": "kid-lightbulbs", "name": "Kid Lightbulbs", "imageUrl": "https://f4.bcbits.com/img/0032895476_23.jpg" },
      "release": {
        "slug": "ruined-castle",
        "title": "RUINED CASTLE",
        "releaseType": "album",
        "releaseDate": "2024-12-06",
        "datePrecision": "day",
        "status": "released",
        "artworkUrl": "https://f4.bcbits.com/img/a123_2.jpg",
        "pricesCheckedAt": "2026-08-01T19:10:35.933+00:00",
        "sources": [
          { "platform": "subvert", "name": "Subvert", "url": "https://www.subvert.fm/kid-lightbulbs/ruined-castle",
            "payoutPercent": "97%", "bandcampFriday": false, "detailCheckedAt": null, "offers": [] },
          { "platform": "bandcamp", "name": "Bandcamp", "url": "https://kidlightbulbs.bandcamp.com/album/ruined-castle",
            "payoutPercent": "80-85%", "bandcampFriday": false, "detailCheckedAt": "2026-08-01T19:10:36.018+00:00",
            "offers": [ { "format": "digital", "price": 5, "currency": "USD", "availability": "available",
                          "capturedAt": "2026-08-01T19:10:35.933+00:00" } ] }
        ]
      },
      "pageUrl": "https://unstream.stream/a/kid-lightbulbs/ruined-castle",
      "bandcampFriday": false
    }
    """

    func testDecodesARealResponse() throws {
        let detail = try JSONDecoder().decode(ReleaseDetail.self, from: Data(responseJSON.utf8))

        XCTAssertEqual(detail.release.title, "RUINED CASTLE")
        XCTAssertEqual(detail.artist.name, "Kid Lightbulbs")
        XCTAssertEqual(detail.pageUrl, "https://unstream.stream/a/kid-lightbulbs/ruined-castle")
        XCTAssertFalse(detail.isUpcoming)
        XCTAssertEqual(detail.release.sources.count, 2)
    }

    func testSourceOrderIsTheServersAndIsNotResorted() throws {
        let detail = try JSONDecoder().decode(ReleaseDetail.self, from: Data(responseJSON.utf8))

        // Artist-paying first. The client must render this order as received — re-deriving it
        // would mean carrying a copy of the payout registry, which is the drift the endpoint's
        // per-source `payoutPercent` exists to eliminate.
        XCTAssertEqual(detail.release.sources.map(\.platform), ["subvert", "bandcamp"])
    }

    func testPayoutPercentComesFromTheResponse() throws {
        let detail = try JSONDecoder().decode(ReleaseDetail.self, from: Data(responseJSON.utf8))
        let bandcamp = try XCTUnwrap(detail.release.sources.first { $0.platform == "bandcamp" })

        XCTAssertEqual(bandcamp.payoutPercent, "80-85%")
        XCTAssertEqual(
            ReleaseFormatting.payout(bandcamp.offers[0].price, bandcamp.offers[0].currency, bandcamp.payoutPercent),
            "≈$4–$4.25 to artist"
        )
    }

    func testASourceWithNoOffersKeepsItsNeverCheckedMarker() throws {
        let detail = try JSONDecoder().decode(ReleaseDetail.self, from: Data(responseJSON.utf8))
        let subvert = try XCTUnwrap(detail.release.sources.first { $0.platform == "subvert" })

        // "We haven't read this page yet" and "this page lists nothing" are different claims,
        // and the UI says something different for each.
        XCTAssertTrue(subvert.offers.isEmpty)
        XCTAssertNil(subvert.detailCheckedAt)
    }

    func testSoldOutOffersAreNotBuyable() {
        let soldOut = ReleaseDetailOffer(
            format: "vinyl", price: 25, currency: "USD", availability: "sold_out", capturedAt: nil
        )
        let unknown = ReleaseDetailOffer(
            format: "cd", price: nil, currency: "USD", availability: "unknown", capturedAt: nil
        )

        // Unknown availability still gets a Buy button — the platform page may well sell it.
        XCTAssertFalse(soldOut.isBuyable)
        XCTAssertTrue(unknown.isBuyable)
    }
}
