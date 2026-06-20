import XCTest
@testable import Unstream

/// Round-trip decode test for SyncedArtist / SyncResponse.
/// Guards against the class of bug where a type mismatch (e.g. UUID string
/// decoded into Int?) silently fails inside a catch block, leaving
/// syncedArtists empty forever (UNS-112 fix).
final class SavedArtistsSyncTests: XCTestCase {

    /// Fixture matching the real /api/saved-artists/sync response shape.
    /// The `id` field is a UUID string (text in JSON), not an integer.
    private static let fixtureJSON: String = """
    {
      "artists": [
        {
          "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          "userId": "user-uuid-1",
          "artistId": "radiohead",
          "name": "Radiohead",
          "slug": "radiohead",
          "imageUrl": "https://example.com/radiohead.jpg",
          "notes": null,
          "addedAt": "2026-01-15T10:30:00Z",
          "supported": true,
          "supportedAt": "2026-02-01T00:00:00Z",
          "lastModified": "2026-06-01T12:00:00Z",
          "deviceId": "mac-studio",
          "claimed": false,
          "deleted": false
        },
        {
          "id": "b2c3d4e5-f6a7-8901-bcde-f23456789012",
          "userId": "user-uuid-1",
          "artistId": "tool",
          "name": "Tool",
          "slug": "tool",
          "imageUrl": null,
          "notes": null,
          "addedAt": "2026-03-10T08:00:00Z",
          "supported": false,
          "supportedAt": null,
          "lastModified": "2026-06-02T14:00:00Z",
          "deviceId": "iphone-15-pro",
          "claimed": false,
          "deleted": false
        },
        {
          "id": "c3d4e5f6-a7b8-9012-cdef-345678901234",
          "userId": "user-uuid-1",
          "artistId": "nirvana",
          "name": "Nirvana",
          "slug": "nirvana",
          "imageUrl": "https://example.com/nirvana.jpg",
          "notes": null,
          "addedAt": "2026-01-20T00:00:00Z",
          "supported": false,
          "supportedAt": null,
          "lastModified": "2026-06-03T09:00:00Z",
          "deviceId": "mac-studio",
          "claimed": true,
          "deleted": true
        }
      ],
      "server_time": "2026-06-03T09:00:00.000Z"
    }
    """

    func testDecodeSyncResponse() throws {
        let jsonData = Self.fixtureJSON.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(SyncResponse.self, from: jsonData)

        XCTAssertEqual(decoded.artists.count, 3)
        XCTAssertEqual(decoded.serverTime, "2026-06-03T09:00:00.000Z")

        // First artist: claimed=false, deleted=false
        let radiohead = decoded.artists[0]
        XCTAssertEqual(radiohead.id, "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
        XCTAssertEqual(radiohead.artistId, "radiohead")
        XCTAssertEqual(radiohead.name, "Radiohead")
        XCTAssertEqual(radiohead.slug, "radiohead")
        XCTAssertEqual(radiohead.imageUrl, "https://example.com/radiohead.jpg")
        XCTAssertEqual(radiohead.supported, true)
        XCTAssertEqual(radiohead.lastModified, "2026-06-01T12:00:00Z")
        XCTAssertEqual(radiohead.deviceId, "mac-studio")
        XCTAssertEqual(radiohead.claimed, false)
        XCTAssertEqual(radiohead.deleted, false)

        // Second artist: null imageUrl, null supportedAt
        let tool = decoded.artists[1]
        XCTAssertEqual(tool.id, "b2c3d4e5-f6a7-8901-bcde-f23456789012")
        XCTAssertEqual(tool.name, "Tool")
        XCTAssertNil(tool.imageUrl)
        XCTAssertEqual(tool.supported, false)
        XCTAssertEqual(tool.deviceId, "iphone-15-pro")
        XCTAssertEqual(tool.deleted, false)

        // Third artist: tombstone (deleted=true)
        let nirvana = decoded.artists[2]
        XCTAssertEqual(nirvana.slug, "nirvana")
        XCTAssertEqual(nirvana.claimed, true)
        XCTAssertEqual(nirvana.deleted, true)
    }

    func testSyncedArtistIdentifiable() throws {
        let jsonData = Self.fixtureJSON.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(SyncResponse.self, from: jsonData)

        // Identifiable conformance: id is String (non-optional)
        let ids = decoded.artists.map(\.id)
        XCTAssertEqual(ids.count, 3)
        XCTAssertEqual(ids[0], "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
    }

    func testTombstoneFiltering() throws {
        let jsonData = Self.fixtureJSON.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(SyncResponse.self, from: jsonData)

        // Simulate the client-side merge: tombstones should be removed, not added
        var bySlug: [String: SyncedArtist] = [:]
        for artist in decoded.artists {
            if artist.deleted == true {
                bySlug.removeValue(forKey: artist.slug)
            } else {
                bySlug[artist.slug] = artist
            }
        }

        let result = Array(bySlug.values).sorted { $0.name < $1.name }
        XCTAssertEqual(result.count, 2)
        XCTAssertFalse(result.contains { $0.slug == "nirvana" })
        XCTAssertTrue(result.contains { $0.slug == "radiohead" })
        XCTAssertTrue(result.contains { $0.slug == "tool" })
    }

    func testEmptyResponse() throws {
        let emptyJSON = """
        {
          "artists": [],
          "server_time": "2026-06-03T10:00:00Z"
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(SyncResponse.self, from: emptyJSON)
        XCTAssertTrue(decoded.artists.isEmpty)
        XCTAssertEqual(decoded.serverTime, "2026-06-03T10:00:00Z")
    }

    func testMissingOptionalFields() throws {
        // Server may omit optional fields — decoder should handle gracefully
        let minimalJSON = """
        {
          "artists": [
            {
              "id": "d4e5f6a7-b8c9-0123-def4-456789012345",
              "artistId": "aphex-twin",
              "name": "Aphex Twin",
              "slug": "aphex-twin"
            }
          ],
          "server_time": "2026-06-03T11:00:00Z"
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(SyncResponse.self, from: minimalJSON)
        XCTAssertEqual(decoded.artists.count, 1)
        let artist = decoded.artists[0]
        XCTAssertEqual(artist.slug, "aphex-twin")
        XCTAssertNil(artist.imageUrl)
        XCTAssertNil(artist.supported)
        XCTAssertNil(artist.lastModified)
        XCTAssertNil(artist.deviceId)
        XCTAssertNil(artist.claimed)
        XCTAssertNil(artist.deleted)
    }
}
