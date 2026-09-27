import Foundation

/// "I'd tip them" and Play my city, against `/api/artist-interest`
/// (docs/specs/artist-patronage-spec.md §3.5, §3.6). No money is involved.
///
/// The signed-in fan's taps are loaded once and shared by every result row, so a results list
/// costs one request rather than one per artist. Public counts come on the search results
/// themselves (`ArtistResult.interest`).
@MainActor
final class ArtistInterestStore: ObservableObject {

    static let shared = ArtistInterestStore()

    /// Slugs of artists this fan would tip.
    @Published private(set) var tip: Set<String> = []
    /// Slug → the city this fan asked the artist to play.
    @Published private(set) var cities: [String: String] = [:]
    /// The fan's profile location, used to pre-fill Play my city.
    @Published private(set) var defaultCity: String?

    private var loadedForToken: String?
    private let endpoint = URL(string: "https://unstream.stream/api/artist-interest")!
    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config)
    }

    private struct MineResponse: Decodable {
        let tip: [String]
        let cities: [String: String]
        let defaultCity: String?
    }

    private struct ErrorResponse: Decodable {
        let error: String?
    }

    /// Load the fan's taps once per session. Safe to call from every row's `.task`.
    func loadIfNeeded() async {
        guard let token = try? await AuthService.shared.currentAccessToken() else { return }
        guard loadedForToken != token else { return }
        loadedForToken = token

        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                loadedForToken = nil
                return
            }
            let mine = try JSONDecoder().decode(MineResponse.self, from: data)
            tip = Set(mine.tip)
            cities = mine.cities
            defaultCity = mine.defaultCity
        } catch {
            loadedForToken = nil
        }
    }

    /// Record or withdraw "I'd tip them". Returns an error message, or nil on success.
    func setTip(slug: String, on: Bool) async -> String? {
        let error = await send(method: on ? "POST" : "DELETE", body: ["slug": slug, "kind": "tip"])
        if error == nil {
            if on { tip.insert(slug) } else { tip.remove(slug) }
        }
        return error
    }

    /// Set this fan's city for the artist, or clear it with nil.
    func setCity(slug: String, city: String?) async -> String? {
        var body = ["slug": slug, "kind": "city"]
        if let city { body["city"] = city }
        let error = await send(method: city == nil ? "DELETE" : "POST", body: body)
        if error == nil { cities[slug] = city }
        return error
    }

    private func send(method: String, body: [String: String]) async -> String? {
        guard let token = try? await AuthService.shared.currentAccessToken() else {
            return "Sign in to Unstream first"
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(body)
        do {
            let (data, response) = try await session.data(for: request)
            if (response as? HTTPURLResponse)?.statusCode == 200 { return nil }
            return (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
                ?? "Couldn't save that. Try again."
        } catch {
            return "Couldn't reach Unstream. Try again."
        }
    }
}
