import Foundation

/// Fetches one release's buying guide from GET /api/release/{artist}/{release}.
///
/// Small on purpose: the server does the ordering and the payout maths, so there is nothing to
/// do here but ask, decode, and be honest about what went wrong.
actor ReleaseDetailService {
    static let shared = ReleaseDetailService()

    private let baseURL = "https://unstream.stream/api"
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        // The endpoint sends `max-age=0, must-revalidate`, so this revalidates rather than
        // serving a stale price — a conditional request, not a fresh download, when nothing moved.
        config.requestCachePolicy = .useProtocolCachePolicy
        self.session = URLSession(configuration: config)
    }

    /// The two slugs in an Unstream release URL.
    ///
    /// Alerts carry `releaseUrl` as the Unstream release page rather than a shop's — that is
    /// pillar 3 of the releases spec — so the slugs the endpoint needs are already in hand and
    /// no extra lookup is required. Alerts produced by the older scrape path carry a *platform*
    /// URL instead, which is why this returns nil rather than guessing: those releases aren't in
    /// the catalog, so there is no guide to show and the caller falls back to opening the link.
    static func slugs(fromReleaseURL urlString: String) -> (artist: String, release: String)? {
        guard let url = URL(string: urlString),
              url.host?.lowercased() == "unstream.stream" else { return nil }

        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count == 3, parts[0] == "a" else { return nil }
        return (parts[1], parts[2])
    }

    /// An artist's catalogue — the list a fan picks a release from before seeing its guide.
    ///
    /// Same three outcomes as `fetch(artist:release:)`: a 404 means no such artist page, anything
    /// else means we couldn't get an answer and must not be rendered as "they have no releases".
    func fetchArtistPage(slug: String) async throws -> ArtistPage {
        guard let encoded = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(baseURL)/artist-page?slug=\(encoded)") else {
            throw ReleaseDetailError.unavailable
        }

        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw ReleaseDetailError.unavailable }

        if http.statusCode == 404 { throw ReleaseDetailError.notFound }
        guard (200...299).contains(http.statusCode) else { throw ReleaseDetailError.unavailable }

        do {
            return try JSONDecoder().decode(ArtistPage.self, from: data)
        } catch {
            print("[ReleaseDetailService] Artist page decode failed for \(slug): \(error)")
            throw ReleaseDetailError.unavailable
        }
    }

    func fetch(artist: String, release: String) async throws -> ReleaseDetail {
        guard let encodedArtist = artist.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let encodedRelease = release.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "\(baseURL)/release/\(encodedArtist)/\(encodedRelease)") else {
            throw ReleaseDetailError.unavailable
        }

        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw ReleaseDetailError.unavailable }

        // 404 means the release genuinely isn't catalogued (or the artist hid it). Everything else
        // — 503 from a database that didn't answer, a rate limit, a 5xx — means we don't know, and
        // the UI must not render "not catalogued" for a question nobody answered.
        if http.statusCode == 404 { throw ReleaseDetailError.notFound }
        guard (200...299).contains(http.statusCode) else { throw ReleaseDetailError.unavailable }

        do {
            return try JSONDecoder().decode(ReleaseDetail.self, from: data)
        } catch {
            print("[ReleaseDetailService] Decode failed for \(artist)/\(release): \(error)")
            throw ReleaseDetailError.unavailable
        }
    }
}

enum ReleaseDetailError: Error {
    /// The release isn't in the catalog. A real answer.
    case notFound
    /// We couldn't get an answer. Not the same thing, and never shown as if it were.
    case unavailable
}
