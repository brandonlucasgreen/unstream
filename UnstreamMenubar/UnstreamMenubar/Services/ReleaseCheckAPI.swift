import Foundation

/// Service to check for new releases via the Unstream API
actor ReleaseCheckAPI {
    private let session: URLSession
    private let baseURL = "https://unstream.dev/.netlify/functions/check-releases"

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    /// Check for new releases for an artist
    /// - Parameters:
    ///   - artistName: The artist's name
    ///   - platforms: Dictionary of platform URLs (bandcamp, faircamp, mirlo, qobuz)
    /// - Returns: The release check result, or nil if no recent release found
    func checkReleases(artistName: String, platforms: [String: String]) async throws -> ReleaseCheckResult? {
        guard let url = URL(string: baseURL) else {
            throw ReleaseCheckAPIError.invalidURL
        }

        // Build request body
        let requestBody: [String: Any] = [
            "artistName": artistName,
            "platforms": platforms
        ]

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

        guard let release = apiResponse.release else {
            return nil
        }

        // Parse the ISO date string to Date
        let dateFormatter = ISO8601DateFormatter()
        dateFormatter.formatOptions = [.withFullDate]

        guard let releaseDate = dateFormatter.date(from: release.releaseDate) else {
            // Try alternative date format (just YYYY-MM-DD)
            let simpleFormatter = DateFormatter()
            simpleFormatter.dateFormat = "yyyy-MM-dd"
            simpleFormatter.locale = Locale(identifier: "en_US_POSIX")

            guard let date = simpleFormatter.date(from: release.releaseDate) else {
                throw ReleaseCheckAPIError.dateParseError
            }

            return ReleaseCheckResult(
                releaseName: release.releaseName,
                releaseDate: date,
                releaseUrl: release.releaseUrl,
                platform: release.platform
            )
        }

        return ReleaseCheckResult(
            releaseName: release.releaseName,
            releaseDate: releaseDate,
            releaseUrl: release.releaseUrl,
            platform: release.platform
        )
    }
}

// MARK: - API Response Types

private struct CheckReleasesResponse: Codable {
    let artistName: String
    let release: APIRelease?
    let error: String?
}

private struct APIRelease: Codable {
    let releaseName: String
    let releaseDate: String
    let releaseUrl: String
    let platform: String
}

// MARK: - Errors

enum ReleaseCheckAPIError: Error {
    case invalidURL
    case encodingError
    case invalidResponse
    case httpError(statusCode: Int)
    case dateParseError
}
