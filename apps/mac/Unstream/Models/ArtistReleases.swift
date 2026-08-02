import Foundation

// An artist's catalogue, as served by GET /api/artist-page?slug={slug}.
//
// This is the missing step between a search result and a buying guide. Searching an artist used
// to be a dead end: the app showed their platform links and nothing else, so there was no way to
// reach their releases or what those releases cost — the thing the whole Releases feature is for.
//
// Only the fields a release list needs are decoded. The endpoint also carries the artist's bio,
// links, social profiles, dividers and featured embed, which the web page renders and this view
// deliberately doesn't; `Codable` ignores what isn't declared, so the extra payload costs nothing
// but bytes.

/// One release in an artist's catalogue.
struct ArtistRelease: Codable, Hashable, Identifiable {
    let slug: String
    let title: String
    let releaseType: String
    let releaseDate: String?
    let datePrecision: String?
    let status: String
    let artworkUrl: String?
    /// "from $8 · ≈$6.80 to artist", or "" when no source has a buyable offer yet.
    ///
    /// **Computed by the server**, like `payoutPercent` on `/api/release` and for the same
    /// reason: pricing it here would mean carrying a copy of the payout registry in Swift.
    /// Empty for an older deploy that doesn't send it, which reads the same as "no price known".
    let offerSummary: String?
    /// Platforms carrying this release, artist-paying-first. Empty on an older deploy.
    let platforms: [String]?

    var id: String { slug }
    var isUpcoming: Bool { status == "announced" }

    private enum CodingKeys: String, CodingKey {
        case slug, title, releaseType, releaseDate, datePrecision, status, artworkUrl
        case offerSummary, platforms
    }
}

struct ArtistPageArtist: Codable, Hashable {
    let slug: String
    let name: String
    let imageUrl: String?
    let city: String?
    let country: String?
    let countryCode: String?

    /// "Austin, Texas" / "Texas" / nil — the same precedence `ArtistLocation` uses, so an artist
    /// reads the same in search results and on their page.
    var locationText: String? {
        let region = country ?? countryCode
        switch (city, region) {
        case let (city?, region?): return "\(city), \(region)"
        case let (city?, nil): return city
        case let (nil, region?): return region
        default: return nil
        }
    }
}

struct ArtistPage: Codable, Hashable {
    let artist: ArtistPageArtist
    let releases: [ArtistRelease]
    /// How many releases exist in total. The endpoint caps `releases` at 60, so this can be
    /// larger — say so rather than implying the list is the whole catalogue.
    let releaseCount: Int?

    var totalReleases: Int { releaseCount ?? releases.count }
}
