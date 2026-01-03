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
        self.platforms = artist.verifiedPlatforms.compactMap { platform in
            guard let url = platform.url else { return nil }
            return SavedPlatform(sourceId: platform.sourceId, url: url)
        }
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
            "buymeacoffee": "Buy Me a Coffee"
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
            "buymeacoffee": "cup.and.saucer"
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
            "buymeacoffee": "#FFDD00"
        ]
        return colors[sourceId] ?? "#888888"
    }
}
