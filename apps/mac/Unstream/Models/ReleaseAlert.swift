import Foundation

/// A new release detected for a saved artist
struct NewRelease: Codable, Identifiable {
    let id: UUID
    let artistName: String
    let releaseName: String
    let releaseDate: Date
    /// The Unstream release page, so a fan lands on the payout comparison rather than one shop.
    let releaseUrl: String
    /// The platform an alert leads with — now any platform in the registry, not a fixed three.
    let platform: String
    /// Every platform this release is on. Empty means the server didn't say (an older deploy).
    let platforms: [String]
    /// "released" or "announced". An announced release is dated in the future.
    let status: String
    /// "from $8 · ≈$6.80 to artist", or "Name your price". Empty when no price is known.
    let offerSummary: String
    let detectedAt: Date

    /// Returns true if this release should still be displayed (within 30 days of detection)
    var isActive: Bool {
        Date().timeIntervalSince(detectedAt) < 30 * 24 * 60 * 60
    }

    var isUpcoming: Bool { status == "announced" }

    /// The leading platform's proper name. `.capitalized` on the raw id renders "Jamcoop" and
    /// "Kofi", which is why every display site should use this instead.
    var displayPlatform: String {
        platformCatalog[platform]?.name ?? platform.capitalized
    }

    init(
        artistName: String,
        releaseName: String,
        releaseDate: Date,
        releaseUrl: String,
        platform: String,
        platforms: [String] = [],
        status: String = "released",
        offerSummary: String = ""
    ) {
        self.id = UUID()
        self.artistName = artistName
        self.releaseName = releaseName
        self.releaseDate = releaseDate
        self.releaseUrl = releaseUrl
        self.platform = platform
        self.platforms = platforms.isEmpty ? [platform] : platforms
        self.status = status
        self.offerSummary = offerSummary
        self.detectedAt = Date()
    }

    // Decoded with defaults so alerts persisted by an earlier build — which had none of the
    // three new fields — still load instead of throwing the whole stored list away.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        artistName = try c.decode(String.self, forKey: .artistName)
        releaseName = try c.decode(String.self, forKey: .releaseName)
        releaseDate = try c.decode(Date.self, forKey: .releaseDate)
        releaseUrl = try c.decode(String.self, forKey: .releaseUrl)
        platform = try c.decode(String.self, forKey: .platform)
        detectedAt = try c.decode(Date.self, forKey: .detectedAt)
        platforms = try c.decodeIfPresent([String].self, forKey: .platforms) ?? [platform]
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "released"
        offerSummary = try c.decodeIfPresent(String.self, forKey: .offerSummary) ?? ""
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

    /// Check if a release is known for an artist on a specific platform
    func isKnownRelease(_ releaseName: String, platform: String, for artistName: String) -> Bool {
        let key = artistName.lowercased()
        guard let releases = knownReleases[key] else { return false }
        return releases.contains { $0.releaseName.lowercased() == releaseName.lowercased() && $0.platform == platform }
    }

    /// Check if a release is known for an artist on ANY platform (by name only)
    func isKnownReleaseByName(_ releaseName: String, for artistName: String) -> Bool {
        let key = artistName.lowercased()
        guard let releases = knownReleases[key] else { return false }
        return releases.contains { $0.releaseName.lowercased() == releaseName.lowercased() }
    }

    /// Remove expired new releases (older than 30 days)
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
    let platforms: [String]
    let status: String
    let offerSummary: String

    init(
        releaseName: String,
        releaseDate: Date,
        releaseUrl: String,
        platform: String,
        platforms: [String] = [],
        status: String = "released",
        offerSummary: String = ""
    ) {
        self.releaseName = releaseName
        self.releaseDate = releaseDate
        self.releaseUrl = releaseUrl
        self.platform = platform
        self.platforms = platforms.isEmpty ? [platform] : platforms
        self.status = status
        self.offerSummary = offerSummary
    }
}
