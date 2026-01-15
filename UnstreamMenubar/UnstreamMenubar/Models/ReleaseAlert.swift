import Foundation

/// A new release detected for a saved artist
struct NewRelease: Codable, Identifiable {
    let id: UUID
    let artistName: String
    let releaseName: String
    let releaseDate: Date
    let releaseUrl: String
    let platform: String  // "bandcamp", "faircamp", or "mirlo"
    let detectedAt: Date

    /// Returns true if this release should still be displayed (within 7 days of detection)
    var isActive: Bool {
        Date().timeIntervalSince(detectedAt) < 7 * 24 * 60 * 60
    }

    init(artistName: String, releaseName: String, releaseDate: Date, releaseUrl: String, platform: String) {
        self.id = UUID()
        self.artistName = artistName
        self.releaseName = releaseName
        self.releaseDate = releaseDate
        self.releaseUrl = releaseUrl
        self.platform = platform
        self.detectedAt = Date()
    }
}

/// Tracks a known release to detect new ones
struct KnownRelease: Codable, Hashable {
    let releaseName: String
    let releaseDate: Date
    let platform: String

    func hash(into hasher: inout Hasher) {
        hasher.combine(releaseName.lowercased())
        hasher.combine(platform)
    }

    static func == (lhs: KnownRelease, rhs: KnownRelease) -> Bool {
        lhs.releaseName.lowercased() == rhs.releaseName.lowercased() && lhs.platform == rhs.platform
    }
}

/// Persisted state for release checking
struct ReleaseCheckState: Codable {
    var lastCheckDate: Date?
    var knownReleases: [String: [KnownRelease]]  // artistName (lowercased) -> releases
    var newReleases: [NewRelease]

    init() {
        self.lastCheckDate = nil
        self.knownReleases = [:]
        self.newReleases = []
    }

    /// Get known releases for an artist (case-insensitive)
    func releases(for artistName: String) -> [KnownRelease] {
        knownReleases[artistName.lowercased()] ?? []
    }

    /// Add a known release for an artist
    mutating func addKnownRelease(_ release: KnownRelease, for artistName: String) {
        let key = artistName.lowercased()
        var existing = knownReleases[key] ?? []
        if !existing.contains(release) {
            existing.append(release)
            knownReleases[key] = existing
        }
    }

    /// Check if a release is known for an artist
    func isKnownRelease(_ releaseName: String, platform: String, for artistName: String) -> Bool {
        let key = artistName.lowercased()
        guard let releases = knownReleases[key] else { return false }
        return releases.contains { $0.releaseName.lowercased() == releaseName.lowercased() && $0.platform == platform }
    }

    /// Remove expired new releases (older than 7 days)
    mutating func pruneExpiredReleases() {
        newReleases = newReleases.filter { $0.isActive }
    }
}

/// Result from checking a platform for releases
struct ReleaseCheckResult {
    let releaseName: String
    let releaseDate: Date
    let releaseUrl: String
    let platform: String
}
