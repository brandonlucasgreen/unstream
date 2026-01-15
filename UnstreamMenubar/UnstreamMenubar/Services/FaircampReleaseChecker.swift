import Foundation

/// Checks Faircamp sites for new releases via RSS feed
actor FaircampReleaseChecker {
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: config)
    }

    /// Fetches the most recent release from a Faircamp site's RSS feed
    /// - Parameter faircampUrl: The Faircamp site URL (e.g., "https://artist.faircamp.audio")
    /// - Returns: The most recent release info, or nil if none found
    func fetchLatestRelease(faircampUrl: String) async throws -> ReleaseCheckResult? {
        // Normalize URL and construct feed URL
        let baseUrl = faircampUrl
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        let feedUrl = baseUrl + "/feed.rss"

        guard let url = URL(string: feedUrl) else {
            throw FaircampError.invalidUrl
        }

        // Fetch the RSS feed
        let (data, _) = try await session.data(from: url)
        guard let xmlString = String(data: data, encoding: .utf8) else {
            throw FaircampError.invalidResponse
        }

        // Parse RSS feed
        let items = parseRssItems(from: xmlString)

        guard !items.isEmpty else {
            return nil
        }

        // Sort by date (newest first) and return the most recent
        guard let mostRecent = items.sorted(by: { $0.date > $1.date }).first else {
            return nil
        }

        return ReleaseCheckResult(
            releaseName: mostRecent.title,
            releaseDate: mostRecent.date,
            releaseUrl: mostRecent.link,
            platform: "faircamp"
        )
    }

    /// Parses RSS items from XML string
    private func parseRssItems(from xml: String) -> [(title: String, link: String, date: Date)] {
        var items: [(title: String, link: String, date: Date)] = []

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

            // Extract pubDate
            guard let pubDateString = extractTagContent(from: itemContent, tag: "pubDate"),
                  let pubDate = parseRssDate(pubDateString) else { continue }

            items.append((title: cleanTitle(title), link: link, date: pubDate))
        }

        return items
    }

    /// Extracts content from an XML tag
    private func extractTagContent(from xml: String, tag: String) -> String? {
        // Try standard tag format
        let pattern = #"<\#(tag)>([^<]*)</\#(tag)>"#
        if let regex = try? NSRegularExpression(pattern: pattern, options: []) {
            let range = NSRange(xml.startIndex..., in: xml)
            if let match = regex.firstMatch(in: xml, options: [], range: range),
               let contentRange = Range(match.range(at: 1), in: xml) {
                return String(xml[contentRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        // Try CDATA format
        let cdataPattern = #"<\#(tag)><!\[CDATA\[(.*?)\]\]></\#(tag)>"#
        if let regex = try? NSRegularExpression(pattern: cdataPattern, options: .dotMatchesLineSeparators) {
            let range = NSRange(xml.startIndex..., in: xml)
            if let match = regex.firstMatch(in: xml, options: [], range: range),
               let contentRange = Range(match.range(at: 1), in: xml) {
                return String(xml[contentRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        return nil
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
}

enum FaircampError: Error {
    case invalidUrl
    case invalidResponse
    case noReleasesFound
}
