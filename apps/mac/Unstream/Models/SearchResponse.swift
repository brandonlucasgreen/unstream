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
    /// Slug for an artist we have a row for but who hasn't claimed their page.
    ///
    /// Optional and decoded leniently because an older deploy of `/api/search/sources` doesn't
    /// send it — before that change only *claimed* artists came back addressable, which is why
    /// the app had no way to reach anyone's releases.
    let knownSlug: String?
    let matchConfidence: String?
    let location: ArtistLocation?

    /// Where this artist's page lives, claimed or not. Nil means the search couldn't place them —
    /// an unverified result, which nothing persists, so there is no page to open.
    var pageSlug: String? { claimedSlug ?? knownSlug }

    /// Platforms that have verified artist presence (excluding social)
    var verifiedPlatforms: [PlatformResult] {
        platforms.filter { !$0.isSearchOnly && !$0.isSocial }
    }

    /// Marketplace platforms where fans can directly support the artist
    /// Only includes platforms in the 'marketplace' category (from the API platform registry)
    var marketplacePlatforms: [PlatformResult] {
        platforms.filter { marketplacePlatformIds.contains($0.sourceId) }
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
