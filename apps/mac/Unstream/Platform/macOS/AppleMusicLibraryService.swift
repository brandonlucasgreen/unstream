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

    private static let storageKey = "appleMusicLibrarySnapshot"

    init() {
        snapshot = Self.loadSnapshot()
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
        UserDefaults.standard.removeObject(forKey: Self.storageKey)
    }
}
#endif
