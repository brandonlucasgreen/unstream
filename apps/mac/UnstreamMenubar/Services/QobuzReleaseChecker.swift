import Foundation

/// Checks Qobuz for new releases via album search results
/// Uses the album search page sorted by release date, which has server-side rendered content
actor QobuzReleaseChecker {
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: config)
    }

    /// Fetches the most recent release for an artist from Qobuz
    /// - Parameter qobuzUrl: The artist's Qobuz URL (e.g., "https://www.qobuz.com/us-en/interpreter/artist-name/12345")
    /// - Returns: The most recent release info, or nil if none found
    func fetchLatestRelease(qobuzUrl: String) async throws -> ReleaseCheckResult? {
        // Extract artist name from URL
        guard let artistName = extractArtistName(from: qobuzUrl) else {
            throw QobuzError.invalidUrl
        }

        // Search for albums by this artist, sorted by release date (newest first)
        // URL encode the artist name and use the date descending sort parameter
        let encodedArtist = artistName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? artistName
        let searchUrl = "https://www.qobuz.com/us-en/search/albums/\(encodedArtist)?ssf%5Bs%5D=main_catalog_date_desc"

        guard let url = URL(string: searchUrl) else {
            throw QobuzError.invalidUrl
        }

        let (data, _) = try await session.data(from: url)
        guard let html = String(data: data, encoding: .utf8) else {
            throw QobuzError.invalidResponse
        }

        // Parse the first album from search results
        guard let release = parseFirstRelease(from: html, artistName: artistName) else {
            return nil
        }

        return release
    }

    /// Extracts artist name from Qobuz URL
    /// e.g., "https://www.qobuz.com/us-en/interpreter/viagra-boys/12345" -> "viagra boys"
    private func extractArtistName(from url: String) -> String? {
        // Pattern: /interpreter/{artist-slug}/{id}
        let pattern = #"/interpreter/([^/]+)/\d+"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return nil
        }

        let range = NSRange(url.startIndex..., in: url)
        guard let match = regex.firstMatch(in: url, options: [], range: range),
              let slugRange = Range(match.range(at: 1), in: url) else {
            return nil
        }

        // Convert slug to name (replace hyphens with spaces)
        let slug = String(url[slugRange])
        return slug.replacingOccurrences(of: "-", with: " ")
    }

    /// Parses the first album release from search results HTML
    private func parseFirstRelease(from html: String, artistName: String) -> ReleaseCheckResult? {
        // Look for ReleaseCard elements with album links
        // Pattern: <a class="CoverModelOverlay" href="/us-en/album/{slug}/{id}" title="More details on {title} by {artist}."
        let cardPattern = #"<a\s+class="CoverModelOverlay"\s+href="(/us-en/album/[^"]+)"\s+title="More details on ([^"]+) by ([^"]+)\.""#

        guard let cardRegex = try? NSRegularExpression(pattern: cardPattern, options: []) else {
            return nil
        }

        let range = NSRange(html.startIndex..., in: html)
        guard let match = cardRegex.firstMatch(in: html, options: [], range: range) else {
            return nil
        }

        // Extract album path
        guard let pathRange = Range(match.range(at: 1), in: html) else {
            return nil
        }
        let albumPath = String(html[pathRange])

        // Extract album title
        guard let titleRange = Range(match.range(at: 2), in: html) else {
            return nil
        }
        let albumTitle = decodeHtmlEntities(String(html[titleRange]))

        // Extract artist from match to verify it's the right artist
        guard let artistRange = Range(match.range(at: 3), in: html) else {
            return nil
        }
        let matchedArtist = String(html[artistRange])

        // Verify the artist matches (case-insensitive)
        let normalizedSearchArtist = artistName.lowercased().trimmingCharacters(in: .whitespaces)
        let normalizedMatchedArtist = matchedArtist.lowercased().trimmingCharacters(in: .whitespaces)

        // Allow partial matches (e.g., "viagra boys" matches "Viagra Boys")
        guard normalizedMatchedArtist.contains(normalizedSearchArtist) ||
              normalizedSearchArtist.contains(normalizedMatchedArtist) else {
            return nil
        }

        // Now find the release date associated with this card
        // The date appears shortly after the album link in a <p class="CoverModelDataDefault ReleaseCardActionsText">
        guard let releaseDate = extractReleaseDate(from: html, afterPosition: match.range.upperBound) else {
            return nil
        }

        let fullUrl = "https://www.qobuz.com\(albumPath)"

        return ReleaseCheckResult(
            releaseName: albumTitle,
            releaseDate: releaseDate,
            releaseUrl: fullUrl,
            platform: "qobuz"
        )
    }

    /// Extracts release date from HTML after a given position
    private func extractReleaseDate(from html: String, afterPosition: Int) -> Date? {
        // Look for date pattern in the next ~500 characters after the album link
        let startIndex = html.index(html.startIndex, offsetBy: afterPosition, limitedBy: html.endIndex) ?? html.endIndex
        let searchEndOffset = min(afterPosition + 500, html.count)
        let endIndex = html.index(html.startIndex, offsetBy: searchEndOffset, limitedBy: html.endIndex) ?? html.endIndex

        guard startIndex < endIndex else { return nil }
        let searchRange = String(html[startIndex..<endIndex])

        // Try various date patterns
        // Pattern 1: "Jan 9, 2026" or "January 9, 2026"
        let monthDayYearPattern = #"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})"#

        if let regex = try? NSRegularExpression(pattern: monthDayYearPattern, options: .caseInsensitive) {
            let range = NSRange(searchRange.startIndex..., in: searchRange)
            if let match = regex.firstMatch(in: searchRange, options: [], range: range) {
                if let monthRange = Range(match.range(at: 1), in: searchRange),
                   let dayRange = Range(match.range(at: 2), in: searchRange),
                   let yearRange = Range(match.range(at: 3), in: searchRange) {
                    let month = String(searchRange[monthRange])
                    let day = String(searchRange[dayRange])
                    let year = String(searchRange[yearRange])

                    return parseDate(month: month, day: day, year: year)
                }
            }
        }

        // Pattern 2: "2026-01-09" (ISO format)
        let isoPattern = #"(\d{4})-(\d{2})-(\d{2})"#
        if let regex = try? NSRegularExpression(pattern: isoPattern, options: []) {
            let range = NSRange(searchRange.startIndex..., in: searchRange)
            if let match = regex.firstMatch(in: searchRange, options: [], range: range) {
                if let fullRange = Range(match.range, in: searchRange) {
                    let dateString = String(searchRange[fullRange])
                    let formatter = DateFormatter()
                    formatter.dateFormat = "yyyy-MM-dd"
                    formatter.locale = Locale(identifier: "en_US_POSIX")
                    return formatter.date(from: dateString)
                }
            }
        }

        return nil
    }

    /// Parses a date from month name, day, and year components
    private func parseDate(month: String, day: String, year: String) -> Date? {
        let dateString = "\(month) \(day), \(year)"

        let formatters: [DateFormatter] = [
            {
                let f = DateFormatter()
                f.dateFormat = "MMMM d, yyyy"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }(),
            {
                let f = DateFormatter()
                f.dateFormat = "MMM d, yyyy"
                f.locale = Locale(identifier: "en_US_POSIX")
                return f
            }()
        ]

        for formatter in formatters {
            if let date = formatter.date(from: dateString) {
                return date
            }
        }

        return nil
    }

    /// Decodes common HTML entities
    private func decodeHtmlEntities(_ string: String) -> String {
        var result = string
        let entities: [(String, String)] = [
            ("&amp;", "&"),
            ("&lt;", "<"),
            ("&gt;", ">"),
            ("&quot;", "\""),
            ("&apos;", "'"),
            ("&#39;", "'"),
            ("&nbsp;", " ")
        ]

        for (entity, replacement) in entities {
            result = result.replacingOccurrences(of: entity, with: replacement)
        }

        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum QobuzError: Error {
    case invalidUrl
    case invalidResponse
    case noReleasesFound
}
