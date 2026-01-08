import Foundation

actor UnstreamAPI {
    private let baseURL = "https://unstream.stream/api"
    private let session: URLSession

    // Cache for recent searches
    private var cache: [String: (results: [ArtistResult], timestamp: Date)] = [:]
    private let cacheDuration: TimeInterval = 300 // 5 minutes

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        self.session = URLSession(configuration: config)
    }

    func searchArtist(_ name: String) async throws -> (results: [ArtistResult], hasPendingEnrichment: Bool) {
        let query = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return ([], false) }

        // Check cache first
        if let cached = cache[query.lowercased()],
           Date().timeIntervalSince(cached.timestamp) < cacheDuration {
            return (cached.results, false) // Already enriched if cached
        }

        guard let encodedQuery = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(baseURL)/search/sources?query=\(encodedQuery)") else {
            throw APIError.invalidURL
        }

        let (data, response) = try await session.data(from: url)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw APIError.requestFailed
        }

        let searchResponse = try JSONDecoder().decode(SearchResponse.self, from: data)

        return (searchResponse.results, searchResponse.hasPendingEnrichment ?? false)
    }

    func fetchMusicBrainzData(_ query: String) async throws -> MusicBrainzResponse? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        guard let encodedQuery = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(baseURL)/search/musicbrainz?query=\(encodedQuery)") else {
            return nil
        }

        do {
            let (data, response) = try await session.data(from: url)

            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else {
                return nil
            }

            return try JSONDecoder().decode(MusicBrainzResponse.self, from: data)
        } catch {
            print("[UnstreamAPI] MusicBrainz fetch failed: \(error)")
            return nil
        }
    }

    /// Normalize string for comparison by removing all non-alphanumeric characters
    private func normalizeForComparison(_ str: String) -> String {
        return str.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    func mergeWithMusicBrainzData(results: [ArtistResult], mbData: MusicBrainzResponse) -> [ArtistResult] {
        guard let artistName = mbData.artistName else { return results }

        let mbNormalized = normalizeForComparison(artistName)

        return results.map { result in
            guard result.type == "artist" else { return result }

            let resultNormalized = normalizeForComparison(result.name)

            // Check if artist name matches (exact, contains, or is contained by)
            let isMatch = resultNormalized == mbNormalized ||
                          resultNormalized.contains(mbNormalized) ||
                          mbNormalized.contains(resultNormalized)

            guard isMatch else { return result }

            var newPlatforms = result.platforms

            // Add official site if available
            if let officialUrl = mbData.officialUrl,
               !newPlatforms.contains(where: { $0.sourceId == "officialsite" }) {
                newPlatforms.append(PlatformResult(sourceId: "officialsite", url: officialUrl, latestRelease: nil))
            }

            // Add Discogs if available
            if let discogsUrl = mbData.discogsUrl,
               !newPlatforms.contains(where: { $0.sourceId == "discogs" }) {
                newPlatforms.append(PlatformResult(sourceId: "discogs", url: discogsUrl, latestRelease: nil))
            }

            // Add library services for artists with pre-2005 releases
            if mbData.hasPre2005Release == true {
                if !newPlatforms.contains(where: { $0.sourceId == "hoopla" }) {
                    let hooplaUrl = "https://www.hoopladigital.com/search?q=\(result.name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? result.name)&type=music"
                    newPlatforms.append(PlatformResult(sourceId: "hoopla", url: hooplaUrl, latestRelease: nil))
                }
                if !newPlatforms.contains(where: { $0.sourceId == "freegal" }) {
                    let freegalUrl = "https://www.freegalmusic.com/search-page/\(result.name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? result.name)"
                    newPlatforms.append(PlatformResult(sourceId: "freegal", url: freegalUrl, latestRelease: nil))
                }
            }

            // Add social links
            if let socialLinks = mbData.socialLinks {
                for social in socialLinks {
                    if !newPlatforms.contains(where: { $0.sourceId == social.platform }) {
                        newPlatforms.append(PlatformResult(sourceId: social.platform, url: social.url, latestRelease: nil))
                    }
                }
            }

            return ArtistResult(id: result.id, name: result.name, type: result.type, imageUrl: result.imageUrl, platforms: newPlatforms)
        }
    }

    func cacheResults(query: String, results: [ArtistResult]) {
        cache[query.lowercased()] = (results, Date())
    }

    func clearCache() {
        cache.removeAll()
    }

    enum APIError: Error {
        case invalidURL
        case requestFailed
        case decodingError
    }
}
