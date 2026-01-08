import Foundation

struct SearchResponse: Codable {
    let query: String
    let results: [ArtistResult]
    let hasPendingEnrichment: Bool?
}

struct SocialLink: Codable {
    let platform: String
    let url: String
}

struct MusicBrainzResponse: Codable {
    let query: String
    let artistName: String?
    let officialUrl: String?
    let discogsUrl: String?
    let hasPre2005Release: Bool?
    let socialLinks: [SocialLink]?
}

struct ArtistResult: Codable, Identifiable {
    let id: String
    let name: String
    let type: String
    let imageUrl: String?
    let platforms: [PlatformResult]

    /// Platforms that have verified artist presence (excluding social)
    var verifiedPlatforms: [PlatformResult] {
        platforms.filter { !$0.isSearchOnly && !$0.isSocial }
    }

    /// Platforms where we can only search (not verified)
    var searchOnlyPlatforms: [PlatformResult] {
        platforms.filter { $0.isSearchOnly }
    }

    /// Social media platforms
    var socialPlatforms: [PlatformResult] {
        platforms.filter { $0.isSocial }
    }
}

struct PlatformResult: Codable, Identifiable {
    let sourceId: String
    let url: String?
    let latestRelease: LatestRelease?

    var id: String { sourceId }

    var displayName: String {
        platformConfig[sourceId]?.name ?? sourceId.capitalized
    }

    var icon: String {
        platformConfig[sourceId]?.icon ?? "music.note"
    }

    var color: String {
        platformConfig[sourceId]?.color ?? "#888888"
    }

    var isSearchOnly: Bool {
        platformConfig[sourceId]?.searchOnly ?? false
    }

    var isSocial: Bool {
        socialPlatformIds.contains(sourceId)
    }
}

struct LatestRelease: Codable {
    let title: String?
    let type: String?
    let url: String?
    let imageUrl: String?
    let releaseDate: String?
}

// Platform configuration
struct PlatformConfig {
    let name: String
    let icon: String
    let color: String
    let searchOnly: Bool
}

private let platformConfig: [String: PlatformConfig] = [
    "bandcamp": PlatformConfig(name: "Bandcamp", icon: "music.note", color: "#1DA0C3", searchOnly: false),
    "mirlo": PlatformConfig(name: "Mirlo", icon: "bird", color: "#BE3455", searchOnly: false),
    "bandwagon": PlatformConfig(name: "Bandwagon", icon: "car", color: "#FF6B35", searchOnly: false),
    "faircamp": PlatformConfig(name: "Faircamp", icon: "tent", color: "#2D5A27", searchOnly: false),
    "qobuz": PlatformConfig(name: "Qobuz", icon: "hifispeaker", color: "#4169E1", searchOnly: false),
    "freegal": PlatformConfig(name: "Freegal", icon: "building.columns", color: "#00A651", searchOnly: false),
    "hoopla": PlatformConfig(name: "Hoopla", icon: "books.vertical", color: "#E31837", searchOnly: false),
    "patreon": PlatformConfig(name: "Patreon", icon: "heart", color: "#FF424D", searchOnly: false),
    // Search-only platforms
    "ampwall": PlatformConfig(name: "Ampwall", icon: "waveform", color: "#EF4444", searchOnly: true),
    "sonica": PlatformConfig(name: "Sonica", icon: "music.quarternote.3", color: "#10B981", searchOnly: true),
    "kofi": PlatformConfig(name: "Ko-fi", icon: "cup.and.saucer", color: "#29ABE0", searchOnly: true),
    "buymeacoffee": PlatformConfig(name: "Buy Me a Coffee", icon: "cup.and.saucer", color: "#FFDD00", searchOnly: true),
    // Official
    "officialsite": PlatformConfig(name: "Official Site", icon: "globe", color: "#71717A", searchOnly: false),
    "discogs": PlatformConfig(name: "Discogs", icon: "opticaldisc", color: "#333333", searchOnly: false),
    // Social platforms
    "instagram": PlatformConfig(name: "Instagram", icon: "camera", color: "#E4405F", searchOnly: false),
    "facebook": PlatformConfig(name: "Facebook", icon: "person.2", color: "#1877F2", searchOnly: false),
    "tiktok": PlatformConfig(name: "TikTok", icon: "music.note", color: "#000000", searchOnly: false),
    "youtube": PlatformConfig(name: "YouTube", icon: "play.rectangle", color: "#FF0000", searchOnly: false),
    "threads": PlatformConfig(name: "Threads", icon: "at", color: "#000000", searchOnly: false),
    "bluesky": PlatformConfig(name: "Bluesky", icon: "cloud", color: "#0085FF", searchOnly: false),
    "twitter": PlatformConfig(name: "X", icon: "xmark", color: "#000000", searchOnly: false),
]

// Social platform IDs for filtering
let socialPlatformIds: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "twitter"]
