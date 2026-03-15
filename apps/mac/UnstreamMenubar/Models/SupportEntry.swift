import Foundation

/// An artist saved to the user's Saved Artists list
struct SupportEntry: Codable, Identifiable {
    let id: UUID
    let artistName: String
    let imageUrl: String?
    let platforms: [SavedPlatform]
    let dateAdded: Date

    init(id: UUID = UUID(), artistName: String, imageUrl: String?, platforms: [SavedPlatform], dateAdded: Date = Date()) {
        self.id = id
        self.artistName = artistName
        self.imageUrl = imageUrl
        self.platforms = platforms
        self.dateAdded = dateAdded
    }

    /// Create a SupportEntry from an ArtistResult
    init(from artist: ArtistResult) {
        self.id = UUID()
        self.artistName = artist.name
        self.imageUrl = artist.imageUrl

        // Collect all platforms with URLs: verified + social
        var allPlatforms: [SavedPlatform] = []

        // Add verified platforms (including officialsite, discogs, etc.)
        for platform in artist.verifiedPlatforms {
            if let url = platform.url {
                allPlatforms.append(SavedPlatform(sourceId: platform.sourceId, url: url))
            }
        }

        // Add social platforms
        for platform in artist.socialPlatforms {
            if let url = platform.url {
                allPlatforms.append(SavedPlatform(sourceId: platform.sourceId, url: url))
            }
        }

        self.platforms = allPlatforms
        self.dateAdded = Date()
    }
}

/// A platform URL saved with a Support Entry
struct SavedPlatform: Codable, Identifiable {
    let sourceId: String
    let url: String

    var id: String { sourceId }

    var displayName: String {
        // Mirror the display names from PlatformResult
        let names: [String: String] = [
            "bandcamp": "Bandcamp",
            "mirlo": "Mirlo",
            "bandwagon": "Bandwagon",
            "faircamp": "Faircamp",
            "qobuz": "Qobuz",
            "freegal": "Freegal",
            "hoopla": "Hoopla",
            "patreon": "Patreon",
            "ampwall": "Ampwall",
            "kofi": "Ko-fi",
            "buymeacoffee": "Buy Me a Coffee",
            "officialsite": "Official Site",
            "discogs": "Discogs",
            "jamcoop": "Jam.coop",
            // Social platforms
            "instagram": "Instagram",
            "facebook": "Facebook",
            "tiktok": "TikTok",
            "youtube": "YouTube",
            "threads": "Threads",
            "bluesky": "Bluesky",
            "mastodon": "Mastodon"
        ]
        return names[sourceId] ?? sourceId.capitalized
    }

    var icon: String {
        let icons: [String: String] = [
            "bandcamp": "music.note",
            "mirlo": "bird",
            "bandwagon": "car",
            "faircamp": "tent",
            "qobuz": "hifispeaker",
            "freegal": "building.columns",
            "hoopla": "books.vertical",
            "patreon": "heart",
            "ampwall": "waveform",
            "kofi": "cup.and.saucer",
            "buymeacoffee": "cup.and.saucer",
            "officialsite": "globe",
            "discogs": "opticaldisc",
            "jamcoop": "guitars",
            // Social platforms
            "instagram": "camera",
            "facebook": "person.2",
            "tiktok": "play.rectangle",
            "youtube": "play.rectangle.fill",
            "threads": "at",
            "bluesky": "cloud",
            "mastodon": "elephant"
        ]
        return icons[sourceId] ?? "music.note"
    }

    var color: String {
        let colors: [String: String] = [
            "bandcamp": "#1DA0C3",
            "mirlo": "#BE3455",
            "bandwagon": "#FF6B35",
            "faircamp": "#2D5A27",
            "qobuz": "#4169E1",
            "freegal": "#00A651",
            "hoopla": "#E31837",
            "patreon": "#FF424D",
            "ampwall": "#EF4444",
            "kofi": "#29ABE0",
            "buymeacoffee": "#FFDD00",
            "officialsite": "#71717A",
            "discogs": "#333333",
            "jamcoop": "#E11D48",
            // Social platforms
            "instagram": "#E4405F",
            "facebook": "#1877F2",
            "tiktok": "#E0E0E0",
            "youtube": "#FF0000",
            "threads": "#E0E0E0",
            "bluesky": "#0085FF",
            "mastodon": "#6364FF"
        ]
        return colors[sourceId] ?? "#888888"
    }
}
