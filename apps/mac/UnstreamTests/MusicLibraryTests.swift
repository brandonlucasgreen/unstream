import XCTest
@testable import Unstream

/// Tests for the Apple Music library import's pure half (Models/MusicLibrary.swift).
/// The provenance mapping is the part that must never drift: support-loop-spec.md §4 says
/// Music.app's `purchased` (iTunes Store) maps to `owned`, NOT to anything resembling
/// direct support — mapping it higher would overstate support on the one number the
/// collection exists to tell the truth about.
final class MusicLibraryTests: XCTestCase {

    // MARK: - Provenance mapping (spec §4 table)

    func testMatchedAndUploadedAreOwnedFiles() {
        XCTAssertEqual(MusicLibrary.provenance(forCloudStatus: "matched"), .owned)
        XCTAssertEqual(MusicLibrary.provenance(forCloudStatus: "uploaded"), .owned)
    }

    func testITunesPurchaseIsOwnedNotSupport() {
        // "purchased" here means iTunes Store — a copy you own, not direct artist support.
        XCTAssertEqual(MusicLibrary.provenance(forCloudStatus: "purchased"), .owned)
    }

    func testSubscriptionIsListenedOnly() {
        XCTAssertEqual(MusicLibrary.provenance(forCloudStatus: "subscription"), .listened)
    }

    func testLocalFileOddStatesCountAsOwned() {
        for status in ["ineligible", "not uploaded", "duplicate", "error"] {
            XCTAssertEqual(MusicLibrary.provenance(forCloudStatus: status), .owned, status)
        }
    }

    func testUncertainStatesClaimLessNotMore() {
        for status in ["unknown", "removed", "no longer available", "prerelease", "garbage"] {
            XCTAssertEqual(MusicLibrary.provenance(forCloudStatus: status), .listened, status)
        }
    }

    // MARK: - Record assembly from AppleScript's parallel arrays

    func testMakeRecordsZipsAlignedArraysAndDecodesStatusCodes() {
        let records = MusicLibrary.makeRecords(
            artists: ["Sufjan Stevens", "  Mirah  "],
            albums: ["Illinois", "Advisory Committee"],
            playCounts: [47, 12],
            statusCodes: ["kPur", "kSub"]
        )
        XCTAssertEqual(records?.count, 2)
        XCTAssertEqual(records?[0], LibraryTrackRecord(artist: "Sufjan Stevens", album: "Illinois", playCount: 47, cloudStatus: "purchased"))
        // Whitespace trimmed, subscription code decoded.
        XCTAssertEqual(records?[1].artist, "Mirah")
        XCTAssertEqual(records?[1].cloudStatus, "subscription")
    }

    func testMakeRecordsRefusesMisalignedArrays() {
        // A length mismatch means the read is broken; zipping would attach statuses to the
        // wrong tracks, so the whole batch is refused.
        XCTAssertNil(MusicLibrary.makeRecords(artists: ["A", "B"], albums: ["X"], playCounts: [1, 2], statusCodes: ["kSub", "kSub"]))
    }

    func testUnknownStatusCodeFallsBackToUnknown() {
        let records = MusicLibrary.makeRecords(artists: ["A"], albums: [""], playCounts: [0], statusCodes: ["zzzz"])
        XCTAssertEqual(records?[0].cloudStatus, "unknown")
    }

    func testNegativePlayCountIsClampedToZero() {
        let records = MusicLibrary.makeRecords(artists: ["A"], albums: [""], playCounts: [-3], statusCodes: ["kSub"])
        XCTAssertEqual(records?[0].playCount, 0)
    }

    // MARK: - Rollup

    private func track(_ artist: String, album: String = "Album", plays: Int = 1, status: String = "subscription") -> LibraryTrackRecord {
        LibraryTrackRecord(artist: artist, album: album, playCount: plays, cloudStatus: status)
    }

    func testRollupAggregatesPerArtistAndSortsByPlays() {
        let snapshot = MusicLibrary.rollup([
            track("Mirah", album: "Advisory Committee", plays: 5, status: "matched"),
            track("Mirah", album: "C'mon Miracle", plays: 10, status: "subscription"),
            track("Sufjan Stevens", album: "Illinois", plays: 3, status: "purchased"),
        ], importedAt: Date())

        XCTAssertEqual(snapshot.trackTotal, 3)
        XCTAssertEqual(snapshot.ownedTotal, 2) // matched + purchased
        XCTAssertEqual(snapshot.subscriptionTotal, 1)
        XCTAssertEqual(snapshot.artists.map(\.name), ["Mirah", "Sufjan Stevens"])

        let mirah = snapshot.artists[0]
        XCTAssertEqual(mirah.trackCount, 2)
        XCTAssertEqual(mirah.ownedTrackCount, 1)
        XCTAssertEqual(mirah.subscriptionTrackCount, 1)
        XCTAssertEqual(mirah.playCount, 15)
        XCTAssertEqual(mirah.albumCount, 2)
    }

    func testRollupMergesDiacriticAndCaseVariantsOfAnArtist() {
        let snapshot = MusicLibrary.rollup([
            track("Sigur Rós", plays: 2),
            track("sigur ros", plays: 3),
        ], importedAt: Date())
        XCTAssertEqual(snapshot.artists.count, 1)
        XCTAssertEqual(snapshot.artists[0].playCount, 5)
    }

    func testTracksWithoutAnArtistCountInTotalsButGetNoRow() {
        let snapshot = MusicLibrary.rollup([
            track("", plays: 9, status: "matched"),
            track("Mirah", plays: 1),
        ], importedAt: Date())
        XCTAssertEqual(snapshot.trackTotal, 2)
        XCTAssertEqual(snapshot.ownedTotal, 1)
        XCTAssertEqual(snapshot.artists.count, 1)
    }

    func testAlbumCountIsCaseInsensitiveDistinct() {
        let snapshot = MusicLibrary.rollup([
            track("Mirah", album: "You Think It's Like This"),
            track("Mirah", album: "you think it's like this"),
        ], importedAt: Date())
        XCTAssertEqual(snapshot.artists[0].albumCount, 1)
    }

    func testEmptyLibraryProducesAnEmptySnapshot() {
        let snapshot = MusicLibrary.rollup([], importedAt: Date())
        XCTAssertEqual(snapshot.trackTotal, 0)
        XCTAssertTrue(snapshot.artists.isEmpty)
    }

    // MARK: - The gap (unsupported artists)

    func testUnsupportedArtistsFiltersByPlaysAndSupportState() {
        let snapshot = MusicLibrary.rollup([
            track("Heavy Rotation", plays: 50),
            track("Already Backed", plays: 40),
            track("Barely Played", plays: 2),
        ], importedAt: Date())

        let gap = MusicLibrary.unsupportedArtists(
            in: snapshot,
            supportedNames: [MusicLibrary.normalizeArtistName("Already Backed")],
            minPlays: 20
        )
        XCTAssertEqual(gap.map(\.name), ["Heavy Rotation"])
    }

    func testSupportComparisonIsDiacriticInsensitive() {
        let snapshot = MusicLibrary.rollup([track("Sigur Rós", plays: 30)], importedAt: Date())
        let gap = MusicLibrary.unsupportedArtists(
            in: snapshot,
            supportedNames: [MusicLibrary.normalizeArtistName("sigur ros")],
            minPlays: 1
        )
        XCTAssertTrue(gap.isEmpty)
    }

    // MARK: - Persistence shape

    func testSnapshotSurvivesACodableRoundTrip() throws {
        let original = MusicLibrary.rollup([
            track("Mirah", album: "Advisory Committee", plays: 5, status: "matched"),
        ], importedAt: Date(timeIntervalSince1970: 1_770_000_000))
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(LibrarySnapshot.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    // MARK: - Apple event enum code decoding

    func testFourCharCodeDecodesOSType() {
        // 'kPur' as a big-endian OSType.
        let code: OSType = (OSType(UInt8(ascii: "k")) << 24)
            | (OSType(UInt8(ascii: "P")) << 16)
            | (OSType(UInt8(ascii: "u")) << 8)
            | OSType(UInt8(ascii: "r"))
        XCTAssertEqual(AppleMusicLibraryService.fourCharCode(code), "kPur")
        XCTAssertEqual(AppleMusicLibraryService.fourCharCode(0), "????")
    }
}
