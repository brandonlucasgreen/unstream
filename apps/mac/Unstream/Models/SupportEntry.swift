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
                allPlatforms.append(SavedPlatform(sourceId: platform.sourceId, url: url, customDisplayName: platform.customDisplayName))
            }
        }

        // Add social platforms
        for platform in artist.socialPlatforms {
            if let url = platform.url {
                allPlatforms.append(SavedPlatform(sourceId: platform.sourceId, url: url, customDisplayName: platform.customDisplayName))
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
    let customDisplayName: String?

    var id: String { sourceId }

    init(sourceId: String, url: String, customDisplayName: String? = nil) {
        self.sourceId = sourceId
        self.url = url
        self.customDisplayName = customDisplayName
    }

    var displayName: String {
        customDisplayName ?? platformCatalog[sourceId]?.name ?? sourceId.capitalized
    }

    var icon: String {
        platformCatalog[sourceId]?.icon ?? "globe"
    }

    var color: String {
        platformCatalog[sourceId]?.color ?? "#888888"
    }
}
