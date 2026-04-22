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

struct ArtistLocation: Codable, Hashable {
    let city: String?
    let country: String?
    let countryCode: String?

    var displayText: String? {
        let region = country ?? countryCode
        switch (city, region) {
        case let (city?, region?): return "\(city), \(region)"
        case let (city?, nil): return city
        case let (nil, region?): return region
        default: return nil
        }
    }
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
    let claimedSlug: String?
    let matchConfidence: String?
    let location: ArtistLocation?

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
    var customDisplayName: String? = nil

    var id: String { sourceId }

    enum CodingKeys: String, CodingKey {
        case sourceId
        case url
        case latestRelease
        case customDisplayName = "displayName"
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

    var artistPayoutPercent: String? {
        platformCatalog[sourceId]?.artistPayoutPercent
    }

    var isSearchOnly: Bool {
        // If platform is normally searchOnly, check if we have a direct link
        let configSearchOnly = platformCatalog[sourceId]?.searchOnly ?? false
        if configSearchOnly, let urlString = url {
            // Direct links should not be treated as searchOnly
            return isSearchUrl(urlString)
        }
        return configSearchOnly
    }

    /// Check if URL is a search URL vs a direct link
    private func isSearchUrl(_ urlString: String) -> Bool {
        let lowercased = urlString.lowercased()
        let searchPatterns = ["/search", "?q=", "?query=", "/explore", "duckduckgo.com"]
        return searchPatterns.contains { lowercased.contains($0) }
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

// Platform configuration and social platform IDs are in PlatformCatalog.swift
