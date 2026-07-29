import Foundation

/// How strictly the API matches the query against artist names.
/// `exact` is for lookups where the query IS the artist's name (now-playing
/// detection, saved-artist refresh) — partial matches would be other artists.
/// `fuzzy` is for the human-typed search field, where "argent" should be able
/// to find "The Argent Grub".
enum SearchMode: String {
    case exact
    case fuzzy
}

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

    func searchArtist(_ name: String, mode: SearchMode = .exact) async throws -> (results: [ArtistResult], hasPendingEnrichment: Bool) {
        let query = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return ([], false) }

        // Check cache first. Keyed by mode too: the fuzzy result set for a name is
        // a superset and must not answer an exact (detection) lookup.
        let cacheKey = "\(mode.rawValue):\(query.lowercased())"
        if let cached = cache[cacheKey],
           Date().timeIntervalSince(cached.timestamp) < cacheDuration {
            return (cached.results, false) // Already enriched if cached
        }

        guard let encodedQuery = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(baseURL)/search/sources?query=\(encodedQuery)&mode=\(mode.rawValue)") else {
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

    func fetchArtistDirectory() async throws -> [IndieArtist] {
        guard let url = URL(string: "\(baseURL)/artist-directory") else {
            throw APIError.invalidURL
        }

        let (data, response) = try await session.data(from: url)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw APIError.requestFailed
        }

        struct DirectoryResponse: Decodable {
            let artists: [IndieArtist]?
        }

        let decoded = try JSONDecoder().decode(DirectoryResponse.self, from: data)
        return decoded.artists ?? []
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

            return ArtistResult(id: result.id, name: result.name, type: result.type, imageUrl: result.imageUrl, platforms: newPlatforms, claimedSlug: result.claimedSlug, matchConfidence: result.matchConfidence, location: result.location)
        }
    }

    /// Fire-and-forget analytics event for artist-level tracking.
    /// Silently ignores errors — analytics should never break the user experience.
    nonisolated func trackAnalyticsEvent(slug: String, metric: String) {
        guard let url = URL(string: "\(baseURL)/analytics/event") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["slug": slug, "metric": metric])
        // Fire and forget — don't await
        Task.detached(priority: .utility) { [session] in
            _ = try? await session.data(for: request)
        }
    }

    /// Fire-and-forget product analytics event (app_events table).
    /// Mirrors the web client's trackAppEvent — sends event_type + app + context.
    nonisolated func trackAppEvent(eventType: String, context: [String: Any] = [:]) {
        guard let url = URL(string: "\(baseURL)/analytics/app-event") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["event_type": eventType, "app": "mac", "context": context]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        Task.detached(priority: .utility) { [session] in
            _ = try? await session.data(for: request)
        }
    }

    func cacheResults(query: String, results: [ArtistResult], mode: SearchMode = .exact) {
        cache["\(mode.rawValue):\(query.lowercased())"] = (results, Date())
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
