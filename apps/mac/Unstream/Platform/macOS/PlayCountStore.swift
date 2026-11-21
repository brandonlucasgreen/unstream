import Foundation
import Combine

/// Keeps the on-device play log (`ListeningLog`) for the Mac app: counts plays from `MediaObserver`
/// and link clicks from `AppState`, and saves them to a JSON file in Application Support (inside
/// the app's sandbox container). Never synced to iCloud or the account, never sent anywhere.
///
/// On by default. Settings → General turns it off, and turning it off deletes the file.
///
/// Used on the main thread only, like `ScrobbleManager`: `MediaObserver` publishes on main and
/// clicks come from views. Saving is synchronous; the file is a few kilobytes and is written once
/// per track at most.
final class PlayCountStore: ObservableObject {
    static let shared = PlayCountStore()

    /// The Settings switch (`@AppStorage` reads the same key). Missing means on.
    static let enabledKey = "playCountingEnabled"
    /// Set once the popover has shown its one-time notice.
    static let noticeSeenKey = "playCountingNoticeSeen"

    @Published private(set) var log: ListeningLog

    /// In memory only: quitting the app mid-track loses that one play, which is cheaper than
    /// persisting a timer.
    private var trackState = PlayTrackState()
    private let defaults: UserDefaults
    private let fileURL: URL?

    init(defaults: UserDefaults = .standard, fileURL: URL? = PlayCountStore.defaultFileURL()) {
        self.defaults = defaults
        self.fileURL = fileURL
        self.log = Self.load(from: fileURL)
    }

    var isEnabled: Bool {
        defaults.object(forKey: Self.enabledKey) as? Bool ?? true
    }

    /// Feed every `MediaObserver.currentTrack` change through here.
    func nowPlayingChanged(to nowPlaying: NowPlaying?) {
        guard isEnabled else { return }
        let now = Date()
        let step: (state: PlayTrackState, countedArtist: String?)
        if let nowPlaying, let artist = nowPlaying.artist,
           !artist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            step = PlayCounting.trackStarted(trackState, artist: artist, title: nowPlaying.title, now: now)
        } else {
            step = PlayCounting.playbackStopped(trackState, now: now)
        }
        trackState = step.state
        if let artist = step.countedArtist {
            update(log.adding(.plays, for: artist, at: now))
        }
    }

    /// A platform link opened for an artist.
    func recordClick(artist: String) {
        guard isEnabled else { return }
        update(log.adding(.clicks, for: artist, at: Date()))
    }

    /// Deletes everything counted so far. Settings calls this when counting is switched off, and
    /// from its Clear button.
    func clear() {
        trackState = PlayTrackState()
        log = ListeningLog()
        if let fileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
    }

    private func update(_ newLog: ListeningLog) {
        log = newLog
        save()
    }

    private func save() {
        guard let fileURL else { return }
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let data = try JSONEncoder().encode(log)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            print("[PlayCountStore] Couldn't save play counts: \(error.localizedDescription)")
        }
    }

    private static func load(from fileURL: URL?) -> ListeningLog {
        guard let fileURL,
              let data = try? Data(contentsOf: fileURL),
              let log = try? JSONDecoder().decode(ListeningLog.self, from: data) else {
            return ListeningLog()
        }
        return log
    }

    static func defaultFileURL() -> URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("Unstream", isDirectory: true)
            .appendingPathComponent("listening-log.json")
    }
}
