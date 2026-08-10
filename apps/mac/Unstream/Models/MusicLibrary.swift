import Foundation

// Apple Music library import — the pure half (support-loop-spec.md Step 2).
//
// Music.app's per-track `cloud status` is what makes the library worth importing: it says
// whether a track is a file the user owns or a subscription stream, so the library can be
// read *with provenance attached*. The AppleScript side lives in
// Platform/macOS/AppleMusicLibraryService.swift; everything here is pure and unit-tested.
//
// The provenance mapping is deliberate and easy to get wrong (spec §4, "Map it carefully"):
// Music.app's `purchased` means *iTunes Store*, which pays through the normal label chain —
// owning a copy, not direct artist support. Nothing imported from Apple Music ever counts
// as support; the strongest claim it can make is "owned".

/// What a track's cloud status tells us about how the user has it.
/// `owned` = their own file (rip, download, or iTunes purchase). `listened` = streaming only.
enum LibraryProvenance: String, Codable {
    case owned
    case listened
}

/// One track as read from Music.app — the minimal set of fields the rollup needs.
struct LibraryTrackRecord: Equatable {
    let artist: String
    let album: String
    let playCount: Int
    /// Music.app cloud status name, e.g. "purchased", "matched", "subscription".
    let cloudStatus: String
}

/// Per-artist aggregate — one row of the eventual Support List.
struct LibraryArtistStats: Codable, Equatable, Identifiable {
    var id: String { name }
    let name: String
    var trackCount: Int
    var ownedTrackCount: Int
    var subscriptionTrackCount: Int
    var playCount: Int
    var albumCount: Int
}

/// The persisted result of a library import.
struct LibrarySnapshot: Codable, Equatable {
    let importedAt: Date
    let trackTotal: Int
    let ownedTotal: Int
    let subscriptionTotal: Int
    /// Sorted by playCount descending — the Support List's default order.
    let artists: [LibraryArtistStats]
}

enum MusicLibrary {
    /// Four-char Apple event codes for Music.app's `eClS` (cloud status) enumeration, from
    /// `sdef /System/Applications/Music.app`. The AppleScript result is decoded to these
    /// codes rather than compared against enum keywords in script source — multi-word
    /// enumerator names like "not uploaded" are ambiguous there ("is not uploaded" parses
    /// as a negation).
    static let cloudStatusNamesByCode: [String: String] = [
        "kUnk": "unknown",
        "kPur": "purchased",
        "kMat": "matched",
        "kUpl": "uploaded",
        "kRej": "ineligible",
        "kRem": "removed",
        "kErr": "error",
        "kDup": "duplicate",
        "kSub": "subscription",
        "kPrR": "prerelease",
        "kRev": "no longer available",
        "kUpP": "not uploaded",
    ]

    /// The spec §4 mapping, extended to the statuses the table doesn't name:
    ///
    ///   matched, uploaded  → owned   (the user's own file, in iCloud)
    ///   purchased          → owned   (iTunes Store — a copy they own, NOT direct support)
    ///   ineligible, not uploaded, duplicate, error
    ///                      → owned   (all describe a *local file* whose upload state is odd)
    ///   everything else    → listened (subscription, unknown, removed, …) — when unsure,
    ///                        claim less. Nothing from Apple Music ever maps to "supported",
    ///                        so an uncertain "listened" can never overstate anything.
    static func provenance(forCloudStatus status: String) -> LibraryProvenance {
        switch status {
        case "matched", "uploaded", "purchased", "ineligible", "not uploaded", "duplicate", "error":
            return .owned
        default:
            return .listened
        }
    }

    /// Zip the parallel per-property arrays AppleScript returns into track records.
    /// Returns nil on a length mismatch — that means the read itself is broken, and a
    /// partial zip would quietly misattribute statuses to the wrong tracks.
    static func makeRecords(
        artists: [String],
        albums: [String],
        playCounts: [Int],
        statusCodes: [String]
    ) -> [LibraryTrackRecord]? {
        let count = artists.count
        guard albums.count == count, playCounts.count == count, statusCodes.count == count else {
            return nil
        }
        return (0..<count).map { i in
            LibraryTrackRecord(
                artist: artists[i].trimmingCharacters(in: .whitespacesAndNewlines),
                album: albums[i].trimmingCharacters(in: .whitespacesAndNewlines),
                playCount: max(0, playCounts[i]),
                cloudStatus: cloudStatusNamesByCode[statusCodes[i]] ?? "unknown"
            )
        }
    }

    /// Aggregate tracks into the per-artist snapshot. Tracks with no artist name are
    /// counted in the totals but produce no artist row (compilations, sound effects).
    static func rollup(_ tracks: [LibraryTrackRecord], importedAt: Date) -> LibrarySnapshot {
        struct Accumulator {
            var name = ""
            var trackCount = 0
            var ownedTrackCount = 0
            var subscriptionTrackCount = 0
            var playCount = 0
            var albums = Set<String>()
        }

        var byArtist: [String: Accumulator] = [:]
        var ownedTotal = 0
        var subscriptionTotal = 0

        for track in tracks {
            let owned = provenance(forCloudStatus: track.cloudStatus) == .owned
            if owned { ownedTotal += 1 }
            let isSubscription = track.cloudStatus == "subscription"
            if isSubscription { subscriptionTotal += 1 }

            guard !track.artist.isEmpty else { continue }
            let key = normalizeArtistName(track.artist)
            var acc = byArtist[key] ?? Accumulator()
            if acc.name.isEmpty { acc.name = track.artist }
            acc.trackCount += 1
            if owned { acc.ownedTrackCount += 1 }
            if isSubscription { acc.subscriptionTrackCount += 1 }
            acc.playCount += track.playCount
            if !track.album.isEmpty { acc.albums.insert(track.album.lowercased()) }
            byArtist[key] = acc
        }

        let artists = byArtist.values
            .map {
                LibraryArtistStats(
                    name: $0.name,
                    trackCount: $0.trackCount,
                    ownedTrackCount: $0.ownedTrackCount,
                    subscriptionTrackCount: $0.subscriptionTrackCount,
                    playCount: $0.playCount,
                    albumCount: $0.albums.count
                )
            }
            .sorted { ($0.playCount, $0.trackCount) > ($1.playCount, $1.trackCount) }

        return LibrarySnapshot(
            importedAt: importedAt,
            trackTotal: tracks.count,
            ownedTotal: ownedTotal,
            subscriptionTotal: subscriptionTotal,
            artists: artists
        )
    }

    /// Case- and diacritic-insensitive key so "Sigur Rós" and "sigur ros" are one artist.
    static func normalizeArtistName(_ name: String) -> String {
        name.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The gap, artist-side: heavily played and never supported. `supportedNames` should be
    /// normalized with normalizeArtistName (the caller owns where support state comes from —
    /// today the local support list, later the server-side collection too).
    static func unsupportedArtists(
        in snapshot: LibrarySnapshot,
        supportedNames: Set<String>,
        minPlays: Int
    ) -> [LibraryArtistStats] {
        snapshot.artists.filter {
            $0.playCount >= minPlays && !supportedNames.contains(normalizeArtistName($0.name))
        }
    }
}
