import Foundation

/// Service for interacting with the ListenBrainz API
class ListenBrainzService {
    static let shared = ListenBrainzService()

    private let baseURL = "https://api.listenbrainz.org"
    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    /// The user's ListenBrainz token (stored in UserDefaults)
    var userToken: String? {
        get { UserDefaults.standard.string(forKey: "listenBrainzToken") }
        set { UserDefaults.standard.set(newValue, forKey: "listenBrainzToken") }
    }

    /// Whether scrobbling is enabled
    var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "listenBrainzEnabled") }
        set { UserDefaults.standard.set(newValue, forKey: "listenBrainzEnabled") }
    }

    /// Validate the user's token by making a test API call
    func validateToken(completion: @escaping (Result<String, Error>) -> Void) {
        guard let token = userToken, !token.isEmpty else {
            completion(.failure(ListenBrainzError.noToken))
            return
        }

        guard let url = URL(string: "\(baseURL)/1/validate-token") else {
            completion(.failure(ListenBrainzError.invalidURL))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Token \(token)", forHTTPHeaderField: "Authorization")

        session.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(ListenBrainzError.invalidResponse))
                return
            }

            if httpResponse.statusCode == 200, let data = data {
                do {
                    if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let valid = json["valid"] as? Bool,
                       valid,
                       let username = json["user_name"] as? String {
                        completion(.success(username))
                    } else {
                        completion(.failure(ListenBrainzError.invalidToken))
                    }
                } catch {
                    completion(.failure(error))
                }
            } else {
                completion(.failure(ListenBrainzError.invalidToken))
            }
        }.resume()
    }

    /// Submit a listen (scrobble) to ListenBrainz
    func submitListen(_ listen: ListenBrainzListen, completion: @escaping (Result<Void, Error>) -> Void) {
        guard let token = userToken, !token.isEmpty else {
            completion(.failure(ListenBrainzError.noToken))
            return
        }

        guard let url = URL(string: "\(baseURL)/1/submit-listens") else {
            completion(.failure(ListenBrainzError.invalidURL))
            return
        }

        let payload = ListenBrainzPayload(
            listenType: "single",
            payload: [listen]
        )

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Token \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            request.httpBody = try encoder.encode(payload)
        } catch {
            completion(.failure(error))
            return
        }

        session.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(ListenBrainzError.invalidResponse))
                return
            }

            if httpResponse.statusCode == 200 {
                print("[ListenBrainz] Successfully submitted listen")
                completion(.success(()))
            } else {
                let errorMessage = data.flatMap { String(data: $0, encoding: .utf8) } ?? "Unknown error"
                print("[ListenBrainz] Submit failed (\(httpResponse.statusCode)): \(errorMessage)")
                completion(.failure(ListenBrainzError.submitFailed(statusCode: httpResponse.statusCode, message: errorMessage)))
            }
        }.resume()
    }

    /// Submit a "playing now" notification (optional, not a scrobble)
    func submitPlayingNow(_ listen: ListenBrainzListen, completion: @escaping (Result<Void, Error>) -> Void) {
        guard let token = userToken, !token.isEmpty else {
            completion(.failure(ListenBrainzError.noToken))
            return
        }

        guard let url = URL(string: "\(baseURL)/1/submit-listens") else {
            completion(.failure(ListenBrainzError.invalidURL))
            return
        }

        // For "playing_now", we don't include listened_at timestamp
        var playingNowListen = listen
        playingNowListen.listenedAt = nil

        let payload = ListenBrainzPayload(
            listenType: "playing_now",
            payload: [playingNowListen]
        )

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Token \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            request.httpBody = try encoder.encode(payload)
        } catch {
            completion(.failure(error))
            return
        }

        session.dataTask(with: request) { data, response, error in
            if let error = error {
                print("[ListenBrainz] Playing now failed: \(error.localizedDescription)")
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(ListenBrainzError.invalidResponse))
                return
            }

            if httpResponse.statusCode == 200 {
                print("[ListenBrainz] Playing now submitted")
                completion(.success(()))
            } else {
                completion(.failure(ListenBrainzError.submitFailed(statusCode: httpResponse.statusCode, message: "Playing now failed")))
            }
        }.resume()
    }
}

// MARK: - Data Models

struct ListenBrainzPayload: Encodable {
    let listenType: String
    let payload: [ListenBrainzListen]
}

struct ListenBrainzListen: Encodable {
    var listenedAt: Int? // Unix timestamp, nil for "playing_now"
    let trackMetadata: TrackMetadata

    struct TrackMetadata: Encodable {
        let artistName: String
        let trackName: String
        let releaseName: String? // Album name
        let additionalInfo: AdditionalInfo?

        struct AdditionalInfo: Encodable {
            let durationMs: Int?
            let mediaPlayer: String?
            let submissionClient: String?
            let submissionClientVersion: String?
            let musicService: String?
        }
    }

    /// Create a listen from NowPlaying data
    static func from(nowPlaying: NowPlaying, listenedAt: Date = Date()) -> ListenBrainzListen? {
        guard let artist = nowPlaying.artist, let title = nowPlaying.title else {
            return nil
        }

        let durationMs = nowPlaying.durationSeconds.map { Int($0 * 1000) }
        let musicService: String? = nowPlaying.source?.rawValue

        return ListenBrainzListen(
            listenedAt: Int(listenedAt.timeIntervalSince1970),
            trackMetadata: TrackMetadata(
                artistName: artist,
                trackName: title,
                releaseName: nowPlaying.album,
                additionalInfo: TrackMetadata.AdditionalInfo(
                    durationMs: durationMs,
                    mediaPlayer: nowPlaying.source?.rawValue,
                    submissionClient: "Unstream",
                    submissionClientVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
                    musicService: musicService
                )
            )
        )
    }
}

// MARK: - Errors

enum ListenBrainzError: LocalizedError {
    case noToken
    case invalidToken
    case invalidURL
    case invalidResponse
    case submitFailed(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .noToken:
            return "No ListenBrainz token configured"
        case .invalidToken:
            return "Invalid ListenBrainz token"
        case .invalidURL:
            return "Invalid URL"
        case .invalidResponse:
            return "Invalid response from server"
        case .submitFailed(let code, let message):
            return "Submit failed (\(code)): \(message)"
        }
    }
}
