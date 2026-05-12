import Foundation

// MARK: - Single source of truth for platform display metadata

/// Configuration for a platform's display properties
struct PlatformConfig {
    let name: String
    let icon: String
    let color: String
    let searchOnly: Bool
    let artistPayoutPercent: String?

    init(name: String, icon: String, color: String, searchOnly: Bool, artistPayoutPercent: String? = nil) {
        self.name = name
        self.icon = icon
        self.color = color
        self.searchOnly = searchOnly
        self.artistPayoutPercent = artistPayoutPercent
    }
}

/// All known platform configurations, keyed by sourceId
let platformCatalog: [String: PlatformConfig] = [
    // Music platforms
    "bandcamp": PlatformConfig(name: "Bandcamp", icon: "music.note", color: "#1DA0C3", searchOnly: false, artistPayoutPercent: "80-85%"),
    "mirlo": PlatformConfig(name: "Mirlo", icon: "bird", color: "#BE3455", searchOnly: false, artistPayoutPercent: "86-90%"),
    "bandwagon": PlatformConfig(name: "Bandwagon", icon: "car", color: "#FF6B35", searchOnly: false),
    "faircamp": PlatformConfig(name: "Faircamp", icon: "tent", color: "#2D5A27", searchOnly: false, artistPayoutPercent: "90-97%"),
    "qobuz": PlatformConfig(name: "Qobuz", icon: "hifispeaker", color: "#4169E1", searchOnly: false, artistPayoutPercent: "~70%"),
    "jamcoop": PlatformConfig(name: "Jam.coop", icon: "guitars", color: "#E11D48", searchOnly: false),
    "freegal": PlatformConfig(name: "Freegal", icon: "building.columns", color: "#00A651", searchOnly: false),
    "hoopla": PlatformConfig(name: "Hoopla", icon: "books.vertical", color: "#E31837", searchOnly: false),
    "patreon": PlatformConfig(name: "Patreon", icon: "heart", color: "#FF424D", searchOnly: false, artistPayoutPercent: "86-90%"),
    // Search-only platforms
    "ampwall": PlatformConfig(name: "Ampwall", icon: "waveform", color: "#EF4444", searchOnly: true, artistPayoutPercent: "92-95%"),
    "subvert": PlatformConfig(name: "Subvert", icon: "fist.raised", color: "#F97316", searchOnly: true, artistPayoutPercent: "~100%"),
    "kofi": PlatformConfig(name: "Ko-fi", icon: "cup.and.saucer", color: "#29ABE0", searchOnly: true, artistPayoutPercent: "92-97%"),
    "buymeacoffee": PlatformConfig(name: "Buy Me a Coffee", icon: "cup.and.saucer", color: "#FFDD00", searchOnly: true, artistPayoutPercent: "~92%"),
    // Official
    "officialsite": PlatformConfig(name: "Official Site", icon: "globe", color: "#71717A", searchOnly: false),
    "discogs": PlatformConfig(name: "Discogs", icon: "opticaldisc", color: "#333333", searchOnly: false),
    // Social platforms
    "instagram": PlatformConfig(name: "Instagram", icon: "camera", color: "#E4405F", searchOnly: false),
    "facebook": PlatformConfig(name: "Facebook", icon: "person.2", color: "#1877F2", searchOnly: false),
    "tiktok": PlatformConfig(name: "TikTok", icon: "music.note", color: "#E0E0E0", searchOnly: false),
    "youtube": PlatformConfig(name: "YouTube", icon: "play.rectangle.fill", color: "#FF0000", searchOnly: false),
    "threads": PlatformConfig(name: "Threads", icon: "at", color: "#E0E0E0", searchOnly: false),
    "bluesky": PlatformConfig(name: "Bluesky", icon: "cloud", color: "#0085FF", searchOnly: false),
    "mastodon": PlatformConfig(name: "Mastodon", icon: "bubble.left.and.bubble.right", color: "#6364FF", searchOnly: false),
    "peertube": PlatformConfig(name: "PeerTube", icon: "play.circle", color: "#F1680D", searchOnly: false),
    // Fallback for artist-added custom links (other, other_*)
    "other": PlatformConfig(name: "Link", icon: "globe", color: "#888888", searchOnly: false),
]

/// Social platform IDs for filtering
let socialPlatformIds: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "mastodon", "peertube"]
