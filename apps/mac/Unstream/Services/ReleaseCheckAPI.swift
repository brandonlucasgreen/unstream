import Foundation

/// Service to check for new releases via the Unstream API
actor ReleaseCheckAPI {
    private let session: URLSession
    private let baseURL = "https://unstream.stream/.netlify/functions/check-releases"

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    /// Check for new releases for an artist.
    ///
    /// Returns **every** release the server reports in the window, not just the newest one.
    /// The server now answers from Unstream's own release catalog where it has one, so a single
    /// call can legitimately describe two new records, an upcoming announcement, and every
    /// platform each is available on — none of which the old single-release shape could carry.
    ///
    /// - Parameters:
    ///   - artistName: The artist's name
    ///   - platforms: Dictionary of platform URLs (bandcamp, faircamp, mirlo)
    ///   - sinceDays: How far back to look. The server defaults to 31 when this is nil.
    /// - Returns: The releases found, newest first. Empty when there are none.
    func checkReleases(
        artistName: String,
        platforms: [String: String],
        sinceDays: Int? = nil
    ) async throws -> [ReleaseCheckResult] {
        guard let url = URL(string: baseURL) else {
            throw ReleaseCheckAPIError.invalidURL
        }

        // Build request body
        var requestBody: [String: Any] = [
            "artistName": artistName,
            "platforms": platforms
        ]
        if let sinceDays {
            requestBody["sinceDays"] = sinceDays
        }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: requestBody) else {
            throw ReleaseCheckAPIError.encodingError
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw ReleaseCheckAPIError.invalidResponse
        }

        guard httpResponse.statusCode == 200 else {
            throw ReleaseCheckAPIError.httpError(statusCode: httpResponse.statusCode)
        }

        // Parse response
        let decoder = JSONDecoder()
        let apiResponse = try decoder.decode(CheckReleasesResponse.self, from: data)

        // Prefer the plural field. `release` is the same data narrowed to one entry, kept by the
        // server for clients older than this one — reading both would double-count.
        let apiReleases = apiResponse.releases ?? apiResponse.release.map { [$0] } ?? []

        // A release whose date won't parse is skipped rather than failing the whole artist:
        // one malformed date should not cost a fan every other alert in the same response.
        return apiReleases.compactMap { release in
            guard let date = Self.parseDate(release.releaseDate) else { return nil }
            return ReleaseCheckResult(
                releaseName: release.releaseName,
                releaseDate: date,
                releaseUrl: release.releaseUrl,
                platform: release.platform,
                platforms: release.platforms ?? [release.platform],
                status: release.status ?? "released",
                offerSummary: release.offerSummary ?? ""
            )
        }
    }

    /// The server sends plain `yyyy-MM-dd`. Both formatters are kept because the field is
    /// declared only as "ISO format" in the API contract.
    private static func parseDate(_ raw: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withFullDate]
        if let date = iso.date(from: raw) { return date }

        let simple = DateFormatter()
        simple.dateFormat = "yyyy-MM-dd"
        simple.locale = Locale(identifier: "en_US_POSIX")
        simple.timeZone = TimeZone(identifier: "UTC")
        return simple.date(from: raw)
    }
}

// MARK: - API Response Types

private struct CheckReleasesResponse: Codable {
    let artistName: String
    let release: APIRelease?
    let releases: [APIRelease]?
    let error: String?
}

private struct APIRelease: Codable {
    let releaseName: String
    let releaseDate: String
    let releaseUrl: String
    let platform: String
    // Optional: absent on the legacy `release` field and on older server deploys.
    let platforms: [String]?
    let status: String?
    let offerSummary: String?
}

// MARK: - Errors

enum ReleaseCheckAPIError: Error {
    case invalidURL
    case encodingError
    case invalidResponse
    case httpError(statusCode: Int)
    case dateParseError
}
