#if os(macOS)
import Foundation
import AppKit

// Reads the Music.app library over Apple events and rolls it up into a LibrarySnapshot
// (support-loop-spec.md Step 2). The pure aggregation half lives in Models/MusicLibrary.swift.
//
// Why AppleScript and not MusicKit or iTunesLibrary.framework: only the scripting
// interface exposes the per-track `cloud status` enumeration, which is what distinguishes
// a file the user owns from a subscription stream — the whole point of the import
// (spec §4). The sandbox's com.apple.Music.library scripting-access group is already in
// Unstream-macOS.entitlements.
//
// The read is four batched `… of every track` fetches — one Apple event each, fast even
// for large libraries — rather than per-track property access, which would be thousands of
// round trips. The script returns raw descriptors and Swift decodes the cloud-status enum
// by its four-char code; comparing multi-word enum names in AppleScript source is a parser
// trap ("is not uploaded" reads as a negation).

enum LibraryImportError: LocalizedError {
    case permissionDenied
    case scriptFailed(Int)
    case malformedResult

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Unstream isn't allowed to read your Music library. Open System Settings → Privacy & Security → Automation and allow Unstream to control Music."
        case .scriptFailed(let code):
            return "Couldn't read the Music library (error \(code)). Make sure Music is installed, then try again."
        case .malformedResult:
            return "The Music library returned data Unstream couldn't read. Try again after Music finishes syncing."
        }
    }
}

/// File-scoped rather than a member of the @MainActor class so the off-main read can use it
/// without actor-isolation complaints.
private let musicLibraryScriptSource = """
tell application "Music"
    set lib to library playlist 1
    set artistNames to artist of every track of lib
    set albumNames to album of every track of lib
    set playCounts to played count of every track of lib
    set cloudStatuses to cloud status of every track of lib
    return {artistNames, albumNames, playCounts, cloudStatuses}
end tell
"""

@MainActor
final class AppleMusicLibraryService: ObservableObject {
    @Published private(set) var snapshot: LibrarySnapshot?
    @Published private(set) var isImporting = false
    @Published private(set) var lastError: String?

    /// When a snapshot was last sent to the signed-in account. Surfaced in the UI because
    /// "nothing leaves this Mac" stops being true the moment this is set, and the user is
    /// owed a plain statement of which of the two states they're in.
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var syncError: String?

    private static let storageKey = "appleMusicLibrarySnapshot"
    private static let syncedAtKey = "appleMusicLibrarySyncedAt"

    init() {
        snapshot = Self.loadSnapshot()
        let stamp = UserDefaults.standard.double(forKey: Self.syncedAtKey)
        lastSyncedAt = stamp > 0 ? Date(timeIntervalSince1970: stamp) : nil
    }

    /// Read the whole library and replace the stored snapshot. The read runs off the main
    /// actor (matching MediaObserver's off-main AppleScript pattern); a large library takes
    /// seconds, not minutes, because the properties are fetched as whole-library batches.
    func importLibrary() async {
        guard !isImporting else { return }
        isImporting = true
        lastError = nil
        defer { isImporting = false }

        let result = await Task.detached(priority: .userInitiated) {
            Self.readLibrary()
        }.value

        switch result {
        case .success(let snap):
            snapshot = snap
            Self.saveSnapshot(snap)
            print("[AppleMusicLibrary] imported \(snap.trackTotal) tracks, \(snap.artists.count) artists (\(snap.ownedTotal) owned, \(snap.subscriptionTotal) subscription)")
            // Signed in, the import is only useful once the gap can be computed server-side.
            // Signed out this returns immediately and nothing leaves the Mac.
            await syncToAccount()
        case .failure(let error):
            lastError = error.localizedDescription
            print("[AppleMusicLibrary] import failed: \(error)")
        }
    }

    // MARK: - AppleScript read (runs off-main)

    nonisolated static func readLibrary() -> Result<LibrarySnapshot, LibraryImportError> {
        guard let script = NSAppleScript(source: musicLibraryScriptSource) else {
            return .failure(.scriptFailed(0))
        }
        var errorDict: NSDictionary?
        let result = script.executeAndReturnError(&errorDict)
        if let error = errorDict {
            let code = error["NSAppleScriptErrorNumber"] as? Int ?? 0
            // -1743: the user declined the Automation prompt. Everything else (Music
            // missing, script broke against a new Music version) is a generic failure —
            // report the code so it's diagnosable.
            return .failure(code == -1743 ? .permissionDenied : .scriptFailed(code))
        }

        guard result.numberOfItems == 4,
              let artistsDesc = result.atIndex(1),
              let albumsDesc = result.atIndex(2),
              let playCountsDesc = result.atIndex(3),
              let statusesDesc = result.atIndex(4)
        else {
            return .failure(.malformedResult)
        }

        guard let records = MusicLibrary.makeRecords(
            artists: stringList(artistsDesc),
            albums: stringList(albumsDesc),
            playCounts: intList(playCountsDesc),
            statusCodes: enumCodeList(statusesDesc)
        ) else {
            // Mismatched list lengths: the read itself is broken. Refuse rather than zip a
            // misaligned library — wrong provenance on the right artist is worse than no data.
            return .failure(.malformedResult)
        }

        return .success(MusicLibrary.rollup(records, importedAt: Date()))
    }

    // MARK: - Descriptor decoding

    private nonisolated static func stringList(_ desc: NSAppleEventDescriptor) -> [String] {
        let n = desc.numberOfItems
        guard n > 0 else { return [] }
        return (1...n).map { desc.atIndex($0)?.stringValue ?? "" }
    }

    private nonisolated static func intList(_ desc: NSAppleEventDescriptor) -> [Int] {
        let n = desc.numberOfItems
        guard n > 0 else { return [] }
        return (1...n).map { Int(desc.atIndex($0)?.int32Value ?? 0) }
    }

    private nonisolated static func enumCodeList(_ desc: NSAppleEventDescriptor) -> [String] {
        let n = desc.numberOfItems
        guard n > 0 else { return [] }
        return (1...n).map { fourCharCode(desc.atIndex($0)?.enumCodeValue ?? 0) }
    }

    nonisolated static func fourCharCode(_ code: OSType) -> String {
        guard code != 0 else { return "????" }
        let bytes = [
            UInt8((code >> 24) & 0xFF),
            UInt8((code >> 16) & 0xFF),
            UInt8((code >> 8) & 0xFF),
            UInt8(code & 0xFF),
        ]
        return String(bytes: bytes, encoding: .macOSRoman) ?? "????"
    }

    // MARK: - Persistence (UserDefaults JSON, same shape as ReleaseAlertManager's state —
    // deliberately NOT iCloud KVS, whose 1 MB quota a real library would blow through)

    private static func loadSnapshot() -> LibrarySnapshot? {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let snapshot = try? JSONDecoder().decode(LibrarySnapshot.self, from: data)
        else { return nil }
        return snapshot
    }

    private static func saveSnapshot(_ snapshot: LibrarySnapshot) {
        if let data = try? JSONEncoder().encode(snapshot) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
    }

    /// Forget the imported library entirely (the snapshot never leaves this Mac to begin
    /// with — it lives only in UserDefaults).
    func clearSnapshot() {
        snapshot = nil
        lastSyncedAt = nil
        syncError = nil
        UserDefaults.standard.removeObject(forKey: Self.storageKey)
        UserDefaults.standard.removeObject(forKey: Self.syncedAtKey)

        // Forgetting locally has to forget remotely too, or "Forget Imported Data" quietly
        // leaves a copy on the server — the exact claim the button is making.
        Task { await deleteRemoteSignals() }
    }

    // MARK: - Sync to the account

    /// Send the per-artist play counts to Unstream so the gap report works on the web and in
    /// the app. Only when signed in: signed out, the snapshot stays on this Mac and this is a
    /// no-op, which is what the Settings copy promises.
    func syncToAccount() async {
        guard let snapshot else { return }
        guard AuthService.shared.isSignedIn,
              let token = try? await AuthService.shared.currentAccessToken() else { return }

        syncError = nil

        // Only artist name and play count leave the device. Not track titles, not album
        // names, not which tracks are subscription streams — the gap needs none of it.
        let signals = snapshot.artists.map { ["artistName": $0.name, "playCount": $0.playCount] }
        let body: [String: Any] = ["source": "apple_music", "signals": signals]

        guard let url = URL(string: "https://unstream.stream/api/me/listening"),
              let payload = try? JSONSerialization.data(withJSONObject: body) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = payload

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                syncError = status == 401
                    ? "Session expired — sign in again to sync your library."
                    : "Couldn't sync your library to Unstream (error \(status))."
                print("[AppleMusicLibrary] sync failed: HTTP \(status)")
                return
            }
            let now = Date()
            lastSyncedAt = now
            UserDefaults.standard.set(now.timeIntervalSince1970, forKey: Self.syncedAtKey)
            print("[AppleMusicLibrary] synced \(signals.count) artists to the account")
        } catch {
            syncError = "Couldn't reach Unstream to sync your library."
            print("[AppleMusicLibrary] sync failed: \(error.localizedDescription)")
        }
    }

    private func deleteRemoteSignals() async {
        guard AuthService.shared.isSignedIn,
              let token = try? await AuthService.shared.currentAccessToken(),
              let url = URL(string: "https://unstream.stream/api/me/listening") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        _ = try? await URLSession.shared.data(for: request)
    }
}
#endif
