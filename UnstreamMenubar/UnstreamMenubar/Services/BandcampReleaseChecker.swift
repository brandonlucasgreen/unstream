import Foundation

/// Checks Bandcamp artist pages for new releases
actor BandcampReleaseChecker {
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: config)
    }

    /// Fetches the most recent release from a Bandcamp artist page
    /// - Parameter bandcampUrl: The artist's Bandcamp URL (e.g., "https://artist.bandcamp.com")
    /// - Returns: The most recent release info, or nil if none found
    func fetchLatestRelease(bandcampUrl: String) async throws -> ReleaseCheckResult? {
        // Normalize URL and construct /music page URL
        let baseUrl = bandcampUrl
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        let musicPageUrl = baseUrl + "/music"

        guard let url = URL(string: musicPageUrl) else {
            throw BandcampError.invalidUrl
        }

        // Fetch the /music page to get album URLs
        let (musicData, _) = try await session.data(from: url)
        guard let musicHtml = String(data: musicData, encoding: .utf8) else {
            throw BandcampError.invalidResponse
        }

        // Extract album URLs from the /music page
        let albumUrls = extractAlbumUrls(from: musicHtml, baseUrl: baseUrl)

        guard !albumUrls.isEmpty else {
            return nil
        }

        // Check the first 5 albums to find the most recent release
        var releases: [(name: String, date: Date, url: String)] = []

        for albumUrl in albumUrls.prefix(5) {
            if let release = try? await fetchAlbumDetails(albumUrl: albumUrl) {
                releases.append(release)
            }
        }

        // Sort by date (newest first) and return the most recent
        guard let mostRecent = releases.sorted(by: { $0.date > $1.date }).first else {
            return nil
        }

        return ReleaseCheckResult(
            releaseName: mostRecent.name,
            releaseDate: mostRecent.date,
            releaseUrl: mostRecent.url,
            platform: "bandcamp"
        )
    }

    /// Extracts album URLs from the /music page HTML
    private func extractAlbumUrls(from html: String, baseUrl: String) -> [String] {
        var urls: [String] = []

        // Pattern to match album links: href="/album/something" or href="https://artist.bandcamp.com/album/something"
        // Also match track links: href="/track/something"
        let patterns = [
            #"href="(/album/[^"]+)""#,
            #"href="(/track/[^"]+)""#,
            #"href="(\#(baseUrl)/album/[^"]+)""#,
            #"href="(\#(baseUrl)/track/[^"]+)""#
        ]

        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: []) {
                let range = NSRange(html.startIndex..., in: html)
                let matches = regex.matches(in: html, options: [], range: range)

                for match in matches {
                    if let pathRange = Range(match.range(at: 1), in: html) {
                        var path = String(html[pathRange])

                        // Convert relative paths to absolute URLs
                        if path.hasPrefix("/") {
                            path = baseUrl + path
                        }

                        // Avoid duplicates
                        if !urls.contains(path) {
                            urls.append(path)
                        }
                    }
                }
            }
        }

        return urls
    }

    /// Fetches album details including release date from an album page
    private func fetchAlbumDetails(albumUrl: String) async throws -> (name: String, date: Date, url: String)? {
        guard let url = URL(string: albumUrl) else {
            return nil
        }

        let (data, _) = try await session.data(from: url)
        guard let html = String(data: data, encoding: .utf8) else {
            return nil
        }

        // Extract album name from og:title or page title
        let albumName = extractAlbumName(from: html)

        // Extract release date from JSON-LD or meta tags
        let releaseDate = extractReleaseDate(from: html)

        guard let name = albumName, let date = releaseDate else {
            return nil
        }

        return (name: name, date: date, url: albumUrl)
    }

    /// Extracts the album name from the HTML
    private func extractAlbumName(from html: String) -> String? {
        // Try og:title first
        if let ogTitle = extractMetaContent(from: html, property: "og:title") {
            // og:title often includes artist name, try to clean it
            // Format can be "Album Name | Artist Name" or "Album Name, by Artist Name"
            if let pipeIndex = ogTitle.firstIndex(of: "|") {
                return String(ogTitle[..<pipeIndex]).trimmingCharacters(in: .whitespaces)
            }
            if let byRange = ogTitle.range(of: ", by ", options: .caseInsensitive) {
                return String(ogTitle[..<byRange.lowerBound]).trimmingCharacters(in: .whitespaces)
            }
            return ogTitle
        }

        // Try JSON-LD name
        if let jsonLdName = extractJsonLdValue(from: html, key: "name") {
            return jsonLdName
        }

        return nil
    }

    /// Extracts the release date from JSON-LD metadata
    private func extractReleaseDate(from html: String) -> Date? {
        // Look for datePublished in JSON-LD
        // Format: "datePublished":"28 Dec 2007 00:00:00 GMT"
        if let dateString = extractJsonLdValue(from: html, key: "datePublished") {
            return parseDate(dateString)
        }

        // Fallback: look for "released" text
        // Pattern: released January 10, 2025
        let releasedPattern = #"released\s+(\w+\s+\d{1,2},?\s+\d{4})"#
        if let regex = try? NSRegularExpression(pattern: releasedPattern, options: .caseInsensitive) {
            let range = NSRange(html.startIndex..., in: html)
            if let match = regex.firstMatch(in: html, options: [], range: range),
               let dateRange = Range(match.range(at: 1), in: html) {
                let dateString = String(html[dateRange])
                return parseDate(dateString)
            }
        }

        return nil
    }

    /// Extracts a value from JSON-LD script tags
    private func extractJsonLdValue(from html: String, key: String) -> String? {
        // Pattern to find the key-value pair in JSON-LD
        let pattern = #""\#(key)"\s*:\s*"([^"]+)""#
        if let regex = try? NSRegularExpression(pattern: pattern, options: []) {
            let range = NSRange(html.startIndex..., in: html)
            if let match = regex.firstMatch(in: html, options: [], range: range),
               let valueRange = Range(match.range(at: 1), in: html) {
                return String(html[valueRange])
            }
        }
        return nil
    }

    /// Extracts meta tag content
    private func extractMetaContent(from html: String, property: String) -> String? {
        let pattern = #"<meta\s+(?:property|name)="\#(property)"\s+content="([^"]+)""#
        if let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) {
            let range = NSRange(html.startIndex..., in: html)
            if let match = regex.firstMatch(in: html, options: [], range: range),
               let contentRange = Range(match.range(at: 1), in: html) {
                return String(html[contentRange])
            }
        }

        // Try alternate order (content before property)
        let altPattern = #"<meta\s+content="([^"]+)"\s+(?:property|name)="\#(property)""#
        if let regex = try? NSRegularExpression(pattern: altPattern, options: .caseInsensitive) {
            let range = NSRange(html.startIndex..., in: html)
            if let match = regex.firstMatch(in: html, options: [], range: range),
               let contentRange = Range(match.range(at: 1), in: html) {
                return String(html[contentRange])
            }
        }

        return nil
    }

    /// Parses various date formats
    private func parseDate(_ dateString: String) -> Date? {
        let formatters: [DateFormatter] = [
            {
                let f = DateFormatter()
                f.dateFormat = "dd MMM yyyy HH:mm:ss zzz"  // "28 Dec 2007 00:00:00 GMT"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }(),
            {
                let f = DateFormatter()
                f.dateFormat = "MMMM d, yyyy"  // "January 10, 2025"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }(),
            {
                let f = DateFormatter()
                f.dateFormat = "MMMM dd, yyyy"  // "January 10, 2025"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }(),
            {
                let f = DateFormatter()
                f.dateFormat = "MMM d, yyyy"  // "Jan 10, 2025"
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

enum BandcampError: Error {
    case invalidUrl
    case invalidResponse
    case noReleasesFound
}
