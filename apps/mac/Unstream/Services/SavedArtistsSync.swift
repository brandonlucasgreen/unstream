import Foundation

/// Syncs saved artists between the app and the Unstream server.
/// Pulls via GET /api/saved-artists/sync?since=<timestamp> and
/// pushes saves/removes via POST /api/saved-artists.
///
/// The 60-second poll covers the "I saved on iOS, walked to my Mac" case.
/// Phase 4 will upgrade this to realtime subscriptions.
@MainActor
class SavedArtistsSync: ObservableObject {

    static let shared = SavedArtistsSync()

    @Published var syncedArtists: [SyncedArtist] = []
    @Published var isSyncing: Bool = false
    @Published var syncError: String?

    private let lastSyncKey = "sync.lastSyncTime"
    private let baseURL = "https://unstream.stream/api"
    private let session: URLSession

    var lastSyncTime: String? {
        get { UserDefaults.standard.string(forKey: lastSyncKey) }
        set { UserDefaults.standard.setValue(newValue, forKey: lastSyncKey) }
    }

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: config)
    }

    // MARK: - Pull

    /// Fetch artists modified since the last sync cursor.
    /// Pass `force = true` to do a full pull (no cursor).
    func pull(force: Bool = false) async {
        guard let token = try? await AuthService.shared.currentAccessToken() else { return }

        isSyncing = true
        syncError = nil

        var urlString = "\(baseURL)/saved-artists/sync"
        if !force, let since = lastSyncTime {
            let encoded = since.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            urlString += "?since=\(encoded)"
        }

        guard let url = URL(string: urlString) else {
            isSyncing = false
            return
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, response) = try await session.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 {
                    syncError = "Session expired — sign in again"
                    isSyncing = false
                    return
                } else if !(200...299).contains(http.statusCode) {
                    syncError = "Couldn't sync — tap to retry"
                    isSyncing = false
                    return
                }
            } else {
                isSyncing = false
                return
            }

            let decoded = try JSONDecoder().decode(SyncResponse.self, from: data)

            if force {
                syncedArtists = decoded.artists.filter { $0.deleted != true }.sorted { $0.name < $1.name }
            } else {
                // Merge: replace existing entries by slug, append new ones.
                // Tombstones (deleted == true) remove the entry instead of adding it.
                var bySlug: [String: SyncedArtist] = [:]
                for artist in syncedArtists {
                    bySlug[artist.slug] = artist
                }
                for artist in decoded.artists {
                    if artist.deleted == true {
                        bySlug.removeValue(forKey: artist.slug)
                    } else {
                        bySlug[artist.slug] = artist
                    }
                }
                syncedArtists = Array(bySlug.values).sorted { $0.name < $1.name }
            }

            lastSyncTime = decoded.serverTime
        } catch {
            syncError = "Couldn't sync — tap to retry"
            print("[Sync] Pull failed: \(error)")
        }

        isSyncing = false
    }

    // MARK: - Push (save)

    /// Save an artist to the server.
    func saveArtist(slug: String, name: String, imageUrl: String?) async {
        guard let token = try? await AuthService.shared.currentAccessToken() else { return }

        guard let url = URL(string: "\(baseURL)/saved-artists") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let body: [String: Any] = [
            "action": "save",
            "artistId": slug,
            "name": name,
            "imageUrl": imageUrl ?? "",
            "device_id": DeviceIDManager.current,
        ]

        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 {
                    syncError = "Session expired — sign in again"
                } else if (200...299).contains(http.statusCode) {
                    // Update sync cursor from the server's authoritative time
                    // so subsequent incremental pulls don't miss this save.
                    if let responseBody = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let serverTime = responseBody["server_time"] as? String {
                        lastSyncTime = serverTime
                    }
                    // Refresh pull to get the server's authoritative version
                    await pull()
                }
            }
        } catch {
            syncError = "Couldn't save — try again"
            print("[Sync] Save failed: \(error)")
        }
    }

    // MARK: - Push (remove)

    /// Remove a saved artist from the server.
    func removeArtist(slug: String) async {
        guard let token = try? await AuthService.shared.currentAccessToken() else { return }

        guard let url = URL(string: "\(baseURL)/saved-artists") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let body: [String: Any] = [
            "action": "remove",
            "artistId": slug,
            "device_id": DeviceIDManager.current,
        ]

        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 {
                    syncError = "Session expired — sign in again"
                } else if (200...299).contains(http.statusCode) {
                    // Update sync cursor from the server's authoritative time
                    if let responseBody = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let serverTime = responseBody["server_time"] as? String {
                        lastSyncTime = serverTime
                    }
                    // Remove from local list immediately
                    syncedArtists.removeAll { $0.slug == slug }
                }
            }
        } catch {
            syncError = "Couldn't remove — try again"
            print("[Sync] Remove failed: \(error)")
        }
    }
}

// MARK: - Models

struct SyncResponse: Codable {
    let artists: [SyncedArtist]
    let serverTime: String

    enum CodingKeys: String, CodingKey {
        case artists
        case serverTime = "server_time"
    }
}

struct SyncedArtist: Codable, Identifiable, Hashable {
    // Server's saved_artists.id is a UUID (text in JSON).
    // Non-optional: if the server ever omits it, the decoder fails loudly
    // at the parse boundary instead of silently at UI time.
    let id: String
    let artistId: String
    let name: String
    let slug: String
    let imageUrl: String?
    let supported: Bool?
    let lastModified: String?
    let deviceId: String?
    let claimed: Bool?
    let deleted: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case artistId
        case name
        case slug
        case imageUrl
        case supported
        case lastModified
        case deviceId
        case claimed
        case deleted
    }

    var displaySlug: String {
        slug.isEmpty ? artistId : slug
    }

    var profileURL: URL? {
        guard !slug.isEmpty else { return nil }
        return URL(string: "https://unstream.stream/a/\(slug)")
    }
}
