import Foundation

/// Service for communicating with a local Plex Media Server to detect music playback.
///
/// Plex detection works by polling the `/status/sessions` endpoint on the user's
/// Plex server. It detects ALL Plex clients (Plexamp, Plex Web, Plex for Mac, etc.)
/// by filtering for `type == "track"` and `Player.state == "playing"`.
///
/// The Plex auth token is stored in the Keychain (not UserDefaults) because it
/// grants full access to the user's Plex server.
class PlexService {
    static let shared = PlexService()

    private let session: URLSession

    private static let keychainTokenKey = "plexAuthToken"
    private static let serverURLDefaultsKey = "plexServerURL"
    private static let enabledDefaultsKey = "plexIntegrationEnabled"

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 3 // Short timeout — skip this cycle if server is slow
        config.timeoutIntervalForResource = 3
        self.session = URLSession(configuration: config)
    }

    // MARK: - Configuration

    /// Whether Plex integration is enabled by the user.
    var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: PlexService.enabledDefaultsKey) }
        set { UserDefaults.standard.set(newValue, forKey: PlexService.enabledDefaultsKey) }
    }

    /// The Plex server URL (stored in UserDefaults — not sensitive).
    /// Defaults to empty string; the UI shows a placeholder of http://localhost:32400.
    var serverURL: String {
        get { UserDefaults.standard.string(forKey: PlexService.serverURLDefaultsKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: PlexService.serverURLDefaultsKey) }
    }

    /// The effective server URL to use for API calls.
    /// Falls back to the default localhost address when the user hasn't set one.
    var effectiveServerURL: String {
        let url = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return url.isEmpty ? "http://localhost:32400" : url
    }

    /// The Plex auth token (stored in Keychain).
    var authToken: String? {
        get { KeychainHelper.load(key: PlexService.keychainTokenKey) }
        set {
            if let value = newValue, !value.isEmpty {
                KeychainHelper.save(key: PlexService.keychainTokenKey, value: value)
            } else {
                KeychainHelper.delete(key: PlexService.keychainTokenKey)
            }
        }
    }

    /// Whether the service has the minimum configuration needed to attempt detection.
    var isConfigured: Bool {
        guard let token = authToken, !token.isEmpty else { return false }
        return isEnabled
    }

    // MARK: - API Methods

    /// Validate the connection by calling `/identity` on the Plex server.
    /// Returns the server's friendly name on success.
    func validateConnection(completion: @escaping (Result<String, PlexError>) -> Void) {
        guard let token = authToken, !token.isEmpty else {
            completion(.failure(.noToken))
            return
        }

        let urlString = "\(effectiveServerURL)/identity"
        guard let url = URL(string: urlString) else {
            completion(.failure(.invalidURL))
            return
        }

        var request = URLRequest(url: url)
        request.setValue(token, forHTTPHeaderField: "X-Plex-Token")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        session.dataTask(with: request) { data, response, error in
            if let error = error {
                print("[PlexService] Connection error: \(error.localizedDescription)")
                completion(.failure(.connectionFailed(error.localizedDescription)))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(.invalidResponse))
                return
            }

            if httpResponse.statusCode == 401 {
                completion(.failure(.unauthorized))
                return
            }

            guard httpResponse.statusCode == 200, let data = data else {
                completion(.failure(.httpError(statusCode: httpResponse.statusCode)))
                return
            }

            // Parse the identity response for the friendly name
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let container = json["MediaContainer"] as? [String: Any],
                   let friendlyName = container["friendlyName"] as? String {
                    completion(.success(friendlyName))
                } else {
                    completion(.success("Plex Server"))
                }
            } catch {
                completion(.success("Plex Server"))
            }
        }.resume()
    }

    /// Fetch the currently playing track from Plex sessions.
    /// Returns nil if nothing is playing or if an error occurs (errors are logged but not surfaced).
    func getNowPlaying() -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        guard isConfigured else { return nil }
        guard let token = authToken else { return nil }

        let urlString = "\(effectiveServerURL)/status/sessions"
        guard let url = URL(string: urlString) else {
            print("[PlexService] Invalid server URL: \(effectiveServerURL)")
            return nil
        }

        var request = URLRequest(url: url)
        request.setValue(token, forHTTPHeaderField: "X-Plex-Token")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        // Synchronous fetch with semaphore (matches the pattern used by Parachord detection)
        let semaphore = DispatchSemaphore(value: 0)
        var trackInfo: (artist: String?, title: String?, album: String?, duration: Double?)? = nil

        session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }

            if let error = error {
                print("[PlexService] Session fetch error: \(error.localizedDescription)")
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else { return }

            if httpResponse.statusCode == 401 {
                print("[PlexService] Unauthorized — token may be invalid")
                // Post notification so the Settings UI can show an error
                DispatchQueue.main.async {
                    NotificationCenter.default.post(
                        name: .plexAuthError,
                        object: nil
                    )
                }
                return
            }

            guard httpResponse.statusCode == 200, let data = data else {
                print("[PlexService] Unexpected status: \(httpResponse.statusCode)")
                return
            }

            trackInfo = self.parseSessionsResponse(data)
        }.resume()

        _ = semaphore.wait(timeout: .now() + 3.0)
        return trackInfo
    }

    // MARK: - Response Parsing

    /// Parse the `/status/sessions` JSON response to find a currently playing music track.
    /// Filters: `type == "track"` AND `Player.state == "playing"`.
    /// Does NOT filter on `Player.product` — detects all Plex clients.
    private func parseSessionsResponse(_ data: Data) -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let container = json["MediaContainer"] as? [String: Any],
              let metadata = container["Metadata"] as? [[String: Any]] else {
            return nil
        }

        // Find the first music track that is actively playing
        for item in metadata {
            guard let type = item["type"] as? String, type == "track" else { continue }

            // Check player state
            guard let player = item["Player"] as? [String: Any],
                  let state = player["state"] as? String,
                  state == "playing" else { continue }

            // Extract track metadata
            // grandparentTitle = artist, title = track name, parentTitle = album
            let artist = item["grandparentTitle"] as? String
            let title = item["title"] as? String
            let album = item["parentTitle"] as? String

            // Plex returns duration in milliseconds
            var duration: Double? = nil
            if let durationMs = item["duration"] as? Int {
                duration = Double(durationMs) / 1000.0
            } else if let durationMs = item["duration"] as? Double {
                duration = durationMs / 1000.0
            }

            if artist != nil || title != nil {
                return (artist, title, album, duration)
            }
        }

        return nil
    }

    // MARK: - Disconnect

    /// Remove all Plex configuration and disable the integration.
    func disconnect() {
        authToken = nil
        serverURL = ""
        isEnabled = false
    }
}

// MARK: - Notification Names

extension Notification.Name {
    /// Posted when Plex returns a 401, indicating the token is invalid or expired.
    static let plexAuthError = Notification.Name("plexAuthError")
}

// MARK: - Errors

enum PlexError: LocalizedError {
    case noToken
    case invalidURL
    case connectionFailed(String)
    case unauthorized
    case invalidResponse
    case httpError(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .noToken:
            return "No Plex token configured"
        case .invalidURL:
            return "Invalid server URL"
        case .connectionFailed(let message):
            return "Cannot reach Plex server: \(message)"
        case .unauthorized:
            return "Invalid Plex token (401 Unauthorized)"
        case .invalidResponse:
            return "Invalid response from Plex server"
        case .httpError(let code):
            return "Plex server error (\(code))"
        }
    }
}
