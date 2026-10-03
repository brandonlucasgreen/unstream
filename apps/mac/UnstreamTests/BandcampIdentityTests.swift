import XCTest
@testable import Unstream

/// Same name, different Bandcamp account = different artist.
///
/// Honeycrush (Brooklyn) and Honey Crush (Orlando, honeycrush.bandcamp.com) normalize to the same
/// name. MusicBrainz knows Brooklyn and lists their (retired) honeyyycrush account; matching on the
/// name alone grafted Brooklyn's official site, socials and bio onto Orlando's card. The same cases
/// are pinned for the backend and web (`bandcamp-identity-conflict.test.ts`) and the extension
/// (`bandcamp-identity-copies.test.ts`); Swift can't be driven from vitest, so the suites agreeing
/// is what keeps the clients on one rule.
final class BandcampIdentityTests: XCTestCase {

    func testSubdomainOfABandcampURL() {
        XCTAssertEqual(UnstreamAPI.bandcampSubdomain(of: "https://honeycrush.bandcamp.com/"), "honeycrush")
        XCTAssertEqual(UnstreamAPI.bandcampSubdomain(of: "https://HoneyCrush.bandcamp.com/music"), "honeycrush")
        XCTAssertNil(UnstreamAPI.bandcampSubdomain(of: "https://bandcamp.com/search?q=honeycrush"))
        // A custom domain may be a Bandcamp site, but the URL can't say so — never a guess.
        XCTAssertNil(UnstreamAPI.bandcampSubdomain(of: "https://honeycrushing.com/"))
        XCTAssertNil(UnstreamAPI.bandcampSubdomain(of: "not a url"))
        XCTAssertNil(UnstreamAPI.bandcampSubdomain(of: nil))
    }

    func testConflictNeedsBothSidesToNameAnAccount() {
        XCTAssertTrue(UnstreamAPI.bandcampSubdomainConflicts("honeyyycrush", "https://honeycrush.bandcamp.com/"))
        XCTAssertFalse(UnstreamAPI.bandcampSubdomainConflicts("honeycrush", "https://honeycrush.bandcamp.com/"))
        // Absence is not conflict.
        XCTAssertFalse(UnstreamAPI.bandcampSubdomainConflicts(nil, "https://honeycrush.bandcamp.com/"))
        XCTAssertFalse(UnstreamAPI.bandcampSubdomainConflicts("honeyyycrush", nil))
        XCTAssertFalse(UnstreamAPI.bandcampSubdomainConflicts("honeyyycrush", "https://honeycrushing.com/"))
    }

    // MARK: - mergeWithMusicBrainzData

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private let orlando = """
    {"id":"honeycrush","name":"Honey Crush","type":"artist","platforms":[{"sourceId":"bandcamp","url":"https://honeycrush.bandcamp.com/"}],"matchConfidence":"verified"}
    """

    private func brooklyn(bandcampSubdomain: String?) -> String {
        let field = bandcampSubdomain.map { ",\"bandcampSubdomain\":\"\($0)\"" } ?? ""
        return """
        {"query":"honeycrush","artistName":"Honeycrush","officialUrl":"https://honeycrush.example/","socialLinks":[{"platform":"instagram","url":"https://www.instagram.com/honeycrushband/"}]\(field)}
        """
    }

    func testLeavesTheSameNameArtistOnAnotherAccountAlone() async throws {
        let result = try decode(ArtistResult.self, orlando)
        let mbData = try decode(MusicBrainzResponse.self, brooklyn(bandcampSubdomain: "honeyyycrush"))

        let merged = await UnstreamAPI().mergeWithMusicBrainzData(results: [result], mbData: mbData)

        XCTAssertEqual(merged[0].platforms.map(\.sourceId), ["bandcamp"])
    }

    func testStillMergesIntoTheSameAccount() async throws {
        let result = try decode(ArtistResult.self, orlando)
        let mbData = try decode(MusicBrainzResponse.self, brooklyn(bandcampSubdomain: "honeycrush"))

        let merged = await UnstreamAPI().mergeWithMusicBrainzData(results: [result], mbData: mbData)

        XCTAssertTrue(merged[0].platforms.contains { $0.sourceId == "officialsite" })
        XCTAssertTrue(merged[0].platforms.contains { $0.sourceId == "instagram" })
    }

    func testAnOlderDeployWithoutTheFieldMergesAsBefore() async throws {
        let result = try decode(ArtistResult.self, orlando)
        let mbData = try decode(MusicBrainzResponse.self, brooklyn(bandcampSubdomain: nil))

        XCTAssertNil(mbData.bandcampSubdomain)
        let merged = await UnstreamAPI().mergeWithMusicBrainzData(results: [result], mbData: mbData)

        XCTAssertTrue(merged[0].platforms.contains { $0.sourceId == "officialsite" })
    }
}
