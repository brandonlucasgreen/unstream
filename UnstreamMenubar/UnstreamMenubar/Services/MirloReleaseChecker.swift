import Foundation

/// Checks Mirlo for new releases via their global RSS feed
actor MirloReleaseChecker {
    private let session: URLSession
    private let feedUrl = "https://api.mirlo.space/v1/trackGroups?format=rss"

    // Cache the RSS feed to avoid fetching multiple times per check cycle
    private var cachedFeed: (items: [RssItem], fetchedAt: Date)?
    private let cacheValiditySeconds: TimeInterval = 300 // 5 minutes

    struct RssItem {
        let title: String
        let link: String
        let pubDate: Date
        let artistSlug: String
    }

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    /// Fetches the most recent release for an artist from Mirlo
    /// - Parameter mirloUrl: The artist's Mirlo URL (e.g., "https://mirlo.space/artist-name")
    /// - Returns: The most recent release info, or nil if none found
    func fetchLatestRelease(mirloUrl: String) async throws -> ReleaseCheckResult? {
        // Extract artist slug from URL
        guard let artistSlug = extractArtistSlug(from: mirloUrl) else {
            throw MirloError.invalidUrl
        }

        // Get the RSS feed (cached or fresh)
        let items = try await fetchRssFeed()

        // Filter items for this artist
        let artistReleases = items.filter { $0.artistSlug == artistSlug }

        guard !artistReleases.isEmpty else {
            return nil
        }

        // Sort by date (newest first) and return the most recent
        guard let mostRecent = artistReleases.sorted(by: { $0.pubDate > $1.pubDate }).first else {
            return nil
        }

        // Extract just the release name (removing " by Artist" suffix if present)
        let releaseName = cleanReleaseName(mostRecent.title)

        return ReleaseCheckResult(
            releaseName: releaseName,
            releaseDate: mostRecent.pubDate,
            releaseUrl: mostRecent.link,
            platform: "mirlo"
        )
    }

    /// Extracts the artist slug from a Mirlo URL
    /// e.g., "https://mirlo.space/shadow-person" -> "shadow-person"
    private func extractArtistSlug(from url: String) -> String? {
        let normalized = url
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        // Handle various URL formats
        // https://mirlo.space/artist-name
        // https://mirlo.space/artist-name/releases
        if let mirloRange = normalized.range(of: "mirlo.space/") {
            let afterMirlo = normalized[mirloRange.upperBound...]
            // Get just the first path component (the artist slug)
            let slug = afterMirlo.split(separator: "/").first.map(String.init)
            return slug?.isEmpty == false ? slug : nil
        }

        return nil
    }

    /// Fetches and parses the RSS feed, using cache if valid
    private func fetchRssFeed() async throws -> [RssItem] {
        // Check cache
        if let cached = cachedFeed,
           Date().timeIntervalSince(cached.fetchedAt) < cacheValiditySeconds {
            return cached.items
        }

        // Fetch fresh feed
        guard let url = URL(string: feedUrl) else {
            throw MirloError.invalidUrl
        }

        let (data, _) = try await session.data(from: url)
        guard let xmlString = String(data: data, encoding: .utf8) else {
            throw MirloError.invalidResponse
        }

        let items = parseRssItems(from: xmlString)

        // Update cache
        cachedFeed = (items: items, fetchedAt: Date())

        return items
    }

    /// Parses RSS items from XML string
    private func parseRssItems(from xml: String) -> [RssItem] {
        var items: [RssItem] = []

        // Extract all <item> blocks
        let itemPattern = #"<item>(.*?)</item>"#
        guard let itemRegex = try? NSRegularExpression(pattern: itemPattern, options: .dotMatchesLineSeparators) else {
            return items
        }

        let range = NSRange(xml.startIndex..., in: xml)
        let matches = itemRegex.matches(in: xml, options: [], range: range)

        for match in matches {
            guard let itemRange = Range(match.range(at: 1), in: xml) else { continue }
            let itemContent = String(xml[itemRange])

            // Extract title
            guard let title = extractTagContent(from: itemContent, tag: "title") else { continue }

            // Extract link
            guard let link = extractTagContent(from: itemContent, tag: "link") else { continue }

            // Extract artist slug from link
            // Link format: https://mirlo.space/{artist-slug}/release/{release-slug}
            guard let artistSlug = extractArtistSlugFromReleaseLink(link) else { continue }

            // Extract pubDate
            guard let pubDateString = extractTagContent(from: itemContent, tag: "pubDate"),
                  let pubDate = parseRssDate(pubDateString) else { continue }

            items.append(RssItem(
                title: cleanTitle(title),
                link: link,
                pubDate: pubDate,
                artistSlug: artistSlug
            ))
        }

        return items
    }

    /// Extracts artist slug from a release link
    /// e.g., "https://mirlo.space/shadow-person/release/album-name" -> "shadow-person"
    private func extractArtistSlugFromReleaseLink(_ link: String) -> String? {
        // Pattern: mirlo.space/{artist}/release/{release}
        if let mirloRange = link.range(of: "mirlo.space/") {
            let afterMirlo = link[mirloRange.upperBound...]
            let components = afterMirlo.split(separator: "/")
            if components.count >= 1 {
                return String(components[0])
            }
        }
        return nil
    }

    /// Extracts content from an XML tag
    private func extractTagContent(from xml: String, tag: String) -> String? {
        // Try CDATA format first (Mirlo uses CDATA)
        let cdataPattern = #"<\#(tag)><!\[CDATA\[(.*?)\]\]></\#(tag)>"#
        if let regex = try? NSRegularExpression(pattern: cdataPattern, options: .dotMatchesLineSeparators) {
            let range = NSRange(xml.startIndex..., in: xml)
            if let match = regex.firstMatch(in: xml, options: [], range: range),
               let contentRange = Range(match.range(at: 1), in: xml) {
                return String(xml[contentRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        // Try standard tag format
        let pattern = #"<\#(tag)>([^<]*)</\#(tag)>"#
        if let regex = try? NSRegularExpression(pattern: pattern, options: []) {
            let range = NSRange(xml.startIndex..., in: xml)
            if let match = regex.firstMatch(in: xml, options: [], range: range),
               let contentRange = Range(match.range(at: 1), in: xml) {
                return String(xml[contentRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        return nil
    }

    /// Cleans the release name by removing " by Artist" suffix
    private func cleanReleaseName(_ title: String) -> String {
        // Mirlo titles are formatted as "Release Name by Artist Name"
        if let byRange = title.range(of: " by ", options: .backwards) {
            return String(title[..<byRange.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        return title
    }

    /// Cleans up title by removing HTML entities and extra whitespace
    private func cleanTitle(_ title: String) -> String {
        var cleaned = title

        // Decode common HTML entities
        let entities: [(String, String)] = [
            ("&amp;", "&"),
            ("&lt;", "<"),
            ("&gt;", ">"),
            ("&quot;", "\""),
            ("&apos;", "'"),
            ("&#39;", "'")
        ]

        for (entity, replacement) in entities {
            cleaned = cleaned.replacingOccurrences(of: entity, with: replacement)
        }

        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Parses RSS date format (RFC 822)
    private func parseRssDate(_ dateString: String) -> Date? {
        let formatters: [DateFormatter] = [
            {
                // RFC 822 format: "Fri, 10 Jan 2025 00:00:00 GMT"
                let f = DateFormatter()
                f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }(),
            {
                // Variation without day name
                let f = DateFormatter()
                f.dateFormat = "dd MMM yyyy HH:mm:ss zzz"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }(),
            {
                // ISO 8601
                let f = DateFormatter()
                f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }(),
            {
                // ISO 8601 with milliseconds
                let f = DateFormatter()
                f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }(),
            {
                // Simple date
                let f = DateFormatter()
                f.dateFormat = "yyyy-MM-dd"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }()
        ]

        let cleanedString = dateString.trimmingCharacters(in: .whitespacesAndNewlines)

        for formatter in formatters {
            if let date = formatter.date(from: cleanedString) {
                return date
            }
        }

        return nil
    }

    /// Clears the RSS feed cache (useful for testing)
    func clearCache() {
        cachedFeed = nil
    }
}

enum MirloError: Error {
    case invalidUrl
    case invalidResponse
    case noReleasesFound
}
