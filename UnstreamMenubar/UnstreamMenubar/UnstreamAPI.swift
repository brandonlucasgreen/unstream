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

    func searchArtist(_ name: String) async throws -> [ArtistResult] {
        let query = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }

        // Check cache first
        if let cached = cache[query.lowercased()],
           Date().timeIntervalSince(cached.timestamp) < cacheDuration {
            return cached.results
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

        // Cache the results
        cache[query.lowercased()] = (searchResponse.results, Date())

        return searchResponse.results
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
