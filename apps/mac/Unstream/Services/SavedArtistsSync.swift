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

        // Queued saves and removes go first, so the pull reads them back.
        if !pendingChanges.isEmpty { await flushPendingChanges() }

        isSyncing = true
        syncError = nil

        // A delta pull is only meaningful when there is something to merge into.
        // `lastSyncTime` lives in UserDefaults and so outlives quit/relaunch,
        // sign-out and sign-in, while `syncedArtists` is in-memory and starts empty
        // every launch. Sending the cursor with an empty list asked the server "what
        // changed since yesterday", got "nothing", merged nothing into nothing, and
        // showed an empty Saved Artists tab with no error — the list only appeared
        // after the poll loop's five-minute forced pull. Treat an empty list as
        // needing a full pull regardless of the cursor.
        let needsFullPull = force || syncedArtists.isEmpty

        var urlString = "\(baseURL)/saved-artists/sync"
        if !needsFullPull, let since = lastSyncTime {
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

            if needsFullPull {
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

            // Anything still queued (offline) stays visible as the fan left it, and says so.
            syncedArtists = Self.applying(pendingChanges, to: syncedArtists)
            if !pendingChanges.isEmpty {
                syncError = "Saved on this device — will sync when you're back online"
            }
            lastSyncTime = decoded.serverTime
        } catch {
            syncError = "Couldn't sync — tap to retry"
            print("[Sync] Pull failed: \(error)")
        }

        isSyncing = false
    }

    // MARK: - Push (outbox)
    //
    // Saves and removes are applied to `syncedArtists` at once and queued in an outbox that
    // outlives a relaunch. Each queued change is sent in order; one that can't reach the server
    // (offline, timeout, 5xx) stays queued and is retried before the next pull, so a heart
    // tapped on a train still lands in the account. Only a change the server *rejects* (a 4xx
    // other than 401) is dropped, with an error naming the artist.

    /// A save or remove waiting to reach the server. At most one per slug: a later change to the
    /// same artist replaces an earlier one, since only the last tap matters.
    struct PendingChange: Codable, Equatable {
        enum Action: String, Codable { case save, remove }
        let action: Action
        let slug: String
        let name: String
        let imageUrl: String?
    }

    private let pendingKey = "sync.pendingChanges"
    private var isFlushing = false

    private(set) var pendingChanges: [PendingChange] {
        get {
            guard let data = UserDefaults.standard.data(forKey: pendingKey) else { return [] }
            return (try? JSONDecoder().decode([PendingChange].self, from: data)) ?? []
        }
        set {
            UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: pendingKey)
        }
    }

    /// Whether the account's saved list holds this artist, counting changes not yet sent.
    func contains(slug: String) -> Bool {
        syncedArtists.contains { $0.displaySlug == slug }
    }

    /// Save an artist to the account. Shown as saved immediately; sent now or, failing that,
    /// on the next pull.
    func saveArtist(slug: String, name: String, imageUrl: String?) async {
        await enqueue(PendingChange(action: .save, slug: slug, name: name, imageUrl: imageUrl))
    }

    /// Remove a saved artist from the account. Removed from the list immediately; sent now or,
    /// failing that, on the next pull.
    func removeArtist(slug: String) async {
        let name = syncedArtists.first { $0.displaySlug == slug }?.name ?? slug
        await enqueue(PendingChange(action: .remove, slug: slug, name: name, imageUrl: nil))
    }

    /// Forget everything tied to the signed-in account. Called on sign-out, so one account's
    /// queued changes can never be sent under the next account to sign in.
    func reset() {
        syncedArtists = []
        pendingChanges = []
        lastSyncTime = nil
        syncError = nil
    }

    private func enqueue(_ change: PendingChange) async {
        var queue = pendingChanges.filter { $0.slug != change.slug }
        queue.append(change)
        pendingChanges = queue
        syncedArtists = Self.applying([change], to: syncedArtists)
        await flushPendingChanges()
    }

    /// Send queued changes in order, stopping at the first that can't reach the server.
    func flushPendingChanges() async {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }

        while let change = pendingChanges.first {
            switch await send(change) {
            case .sent(let serverTime):
                pendingChanges = Array(pendingChanges.dropFirst())
                // Move the cursor only when nothing else is waiting: a cursor past an unsent
                // change is harmless, but one past another device's change would skip it.
                if let serverTime, pendingChanges.isEmpty, lastSyncTime != nil {
                    lastSyncTime = serverTime
                }
            case .rejected:
                pendingChanges = Array(pendingChanges.dropFirst())
                syncError = change.action == .save
                    ? "Couldn't save \(change.name) to your account"
                    : "Couldn't remove \(change.name) from your account"
                // Undo the optimistic change; the next full pull shows the server's truth.
                await pull(force: true)
                return
            case .unauthorized:
                syncError = "Session expired — sign in again"
                return
            case .offline:
                syncError = "Saved on this device — will sync when you're back online"
                return
            }
        }
    }

    private enum SendOutcome {
        case sent(serverTime: String?)
        case rejected
        case unauthorized
        case offline
    }

    private func send(_ change: PendingChange) async -> SendOutcome {
        guard let token = try? await AuthService.shared.currentAccessToken() else { return .unauthorized }
        guard let url = URL(string: "\(baseURL)/saved-artists") else { return .rejected }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        var body: [String: Any] = [
            "action": change.action.rawValue,
            "artistId": change.slug,
            "device_id": DeviceIDManager.current,
        ]
        if change.action == .save {
            body["name"] = change.name
            body["imageUrl"] = change.imageUrl ?? ""
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .offline }
            switch http.statusCode {
            case 200...299:
                let responseBody = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                return .sent(serverTime: responseBody?["server_time"] as? String)
            case 401:
                return .unauthorized
            case 408, 429, 500...599:
                return .offline
            default:
                return .rejected
            }
        } catch {
            print("[Sync] \(change.action.rawValue) failed for \(change.slug): \(error)")
            return .offline
        }
    }

    /// The list as it will be once these changes reach the server. Applied after every pull
    /// too, so a queued save doesn't vanish from the list just because the server hasn't
    /// heard about it yet.
    static func applying(_ changes: [PendingChange], to artists: [SyncedArtist]) -> [SyncedArtist] {
        var result = artists
        for change in changes {
            result.removeAll { $0.displaySlug == change.slug }
            if change.action == .save {
                result.append(SyncedArtist(
                    id: "pending-\(change.slug)",
                    artistId: change.slug,
                    name: change.name,
                    slug: change.slug,
                    imageUrl: change.imageUrl,
                    supported: nil,
                    lastModified: nil,
                    deviceId: DeviceIDManager.current,
                    claimed: nil,
                    deleted: nil
                ))
            }
        }
        return result.sorted { $0.name < $1.name }
    }
}

// MARK: - One saved list

/// Where the heart button saves to. **Signed in, the account is the saved list** — on every
/// device, and for release checks. The local `SupportListManager` list (iCloud key-value
/// storage) is the signed-out list. Before this, the heart always wrote to the local list, so
/// on macOS an artist saved before signing in seemed to vanish at sign-in (the popover switches
/// to the account's list) and release alerts ignored everything saved on the web.
///
/// Local entries are never deleted on sign-in: they stay as the signed-out list, and
/// `SyncedArtistsView` offers to add the ones the account lacks. Merging them silently
/// would put artists into an account without the fan asking.
@MainActor
enum SavedArtistsRouter {
    /// The identifier an artist is saved under: the slug of their Unstream page when the
    /// search placed them (as the web and extension do), else a slug computed the way the
    /// server computes it. Nil when the name has nothing to slug (a name with no Latin
    /// letters), which can only be saved on this device.
    static func slug(for artist: ArtistResult) -> String? {
        if let pageSlug = artist.pageSlug { return pageSlug }
        let computed = ArtistSlug.make(artist.name)
        return computed.isEmpty ? nil : computed
    }

    static func isSaved(_ artist: ArtistResult, local: SupportListManager) -> Bool {
        if AuthService.shared.isSignedIn, let slug = slug(for: artist) {
            return SavedArtistsSync.shared.contains(slug: slug)
        }
        return local.isArtistSaved(artist.name)
    }

    static func toggle(_ artist: ArtistResult, local: SupportListManager) {
        guard AuthService.shared.isSignedIn, let slug = slug(for: artist) else {
            local.toggleArtist(artist)
            return
        }
        let sync = SavedArtistsSync.shared
        Task {
            if sync.contains(slug: slug) {
                await sync.removeArtist(slug: slug)
            } else {
                await sync.saveArtist(slug: slug, name: artist.name, imageUrl: artist.imageUrl)
            }
        }
    }

    /// Artists saved on this device (signed out, or before this build) that the account
    /// doesn't hold, matched by name or computed slug.
    static func localEntriesMissingFromAccount(local: SupportListManager) -> [SupportEntry] {
        let synced = SavedArtistsSync.shared.syncedArtists
        let names = Set(synced.map { $0.name.lowercased() })
        let slugs = Set(synced.map { $0.displaySlug })
        return local.entries.filter { entry in
            !names.contains(entry.artistName.lowercased()) && !slugs.contains(ArtistSlug.make(entry.artistName))
        }
    }

    /// Add local entries to the account, on the fan's say-so. Entries whose name can't be
    /// slugged stay local only.
    static func addToAccount(_ entries: [SupportEntry]) {
        let sync = SavedArtistsSync.shared
        Task {
            for entry in entries {
                let slug = ArtistSlug.make(entry.artistName)
                guard !slug.isEmpty else { continue }
                await sync.saveArtist(slug: slug, name: entry.artistName, imageUrl: entry.imageUrl)
            }
        }
    }
}

/// An artist slug computed on the device, for an artist the search didn't place on a page.
/// **Mirrors `artistSlug()` in api/functions/db.ts** — accents folded, not stripped (Björk is
/// `bjork`, not `bj-rk`), so a save resolves to the same artist row the server would create.
enum ArtistSlug {
    private static let nonDecomposingLatin: [Character: String] = [
        "ø": "o", "Ø": "O", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ð": "d", "Ð": "D",
        "þ": "th", "Þ": "Th", "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe", "ß": "ss",
        "ħ": "h", "Ħ": "H", "ŋ": "n", "Ŋ": "N", "ı": "i", "ŧ": "t", "Ŧ": "T",
    ]

    static func make(_ name: String) -> String {
        let stripped = name.applyingTransform(.stripDiacritics, reverse: false) ?? name
        let folded = stripped.map { nonDecomposingLatin[$0] ?? String($0) }.joined()
        return folded.lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
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
        guard claimed == true, !slug.isEmpty else { return nil }
        return URL(string: "https://unstream.stream/a/\(slug)")
    }
}
