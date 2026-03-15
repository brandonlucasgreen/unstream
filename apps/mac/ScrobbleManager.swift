import Foundation
import Combine

/// Manages scrobbling logic - tracks playback time and submits scrobbles when threshold is met
class ScrobbleManager: ObservableObject {
    static let shared = ScrobbleManager()

    // Scrobble threshold: 50% of track OR 4 minutes, whichever comes first
    private let maxScrobbleThresholdSeconds: Double = 240.0 // 4 minutes

    // Track current playback state
    private var currentTrackId: String?
    private var trackStartTime: Date?
    private var accumulatedPlayTime: TimeInterval = 0
    private var hasScrobbled: Bool = false
    private var playingNowSent: Bool = false

    // Timer to check playback progress
    private var playbackTimer: Timer?
    private let checkInterval: TimeInterval = 5.0

    // Published state for UI
    @Published var lastScrobbledTrack: String?
    @Published var scrobbleCount: Int = 0

    private let listenBrainz = ListenBrainzService.shared
    private var cancellables = Set<AnyCancellable>()

    private init() {
        // Load scrobble count from UserDefaults
        scrobbleCount = UserDefaults.standard.integer(forKey: "scrobbleCount")
    }

    /// Call this when a track starts or changes
    func trackChanged(to nowPlaying: NowPlaying?) {
        guard listenBrainz.isEnabled, listenBrainz.userToken != nil else {
            return
        }

        // If track is nil (nothing playing), stop tracking
        guard let track = nowPlaying, track.hasContent else {
            stopTracking()
            return
        }

        let newTrackId = track.trackId

        // If same track, continue tracking
        if newTrackId == currentTrackId {
            return
        }

        // New track - reset state
        print("[ScrobbleManager] New track: \(track.artist ?? "?") - \(track.title ?? "?")")

        currentTrackId = newTrackId
        trackStartTime = Date()
        accumulatedPlayTime = 0
        hasScrobbled = false
        playingNowSent = false

        // Send "playing now" notification
        sendPlayingNow(track)

        // Start tracking playback time
        startPlaybackTimer(for: track)
    }

    /// Call this when playback is paused
    func playbackPaused() {
        // Accumulate play time up to this point
        if let startTime = trackStartTime {
            accumulatedPlayTime += Date().timeIntervalSince(startTime)
            trackStartTime = nil
        }
        playbackTimer?.invalidate()
        playbackTimer = nil
        print("[ScrobbleManager] Playback paused, accumulated: \(Int(accumulatedPlayTime))s")
    }

    /// Call this when playback resumes
    func playbackResumed(track: NowPlaying) {
        guard listenBrainz.isEnabled, !hasScrobbled else { return }

        trackStartTime = Date()
        startPlaybackTimer(for: track)
        print("[ScrobbleManager] Playback resumed")
    }

    private func stopTracking() {
        playbackTimer?.invalidate()
        playbackTimer = nil
        currentTrackId = nil
        trackStartTime = nil
        accumulatedPlayTime = 0
        hasScrobbled = false
        playingNowSent = false
    }

    private func startPlaybackTimer(for track: NowPlaying) {
        playbackTimer?.invalidate()

        playbackTimer = Timer.scheduledTimer(withTimeInterval: checkInterval, repeats: true) { [weak self] _ in
            self?.checkScrobbleThreshold(for: track)
        }
    }

    private func checkScrobbleThreshold(for track: NowPlaying) {
        guard !hasScrobbled, let startTime = trackStartTime else { return }

        // Calculate total play time
        let currentSessionTime = Date().timeIntervalSince(startTime)
        let totalPlayTime = accumulatedPlayTime + currentSessionTime

        // Calculate threshold
        let threshold: Double
        if let duration = track.durationSeconds, duration > 0 {
            // Threshold is 50% of track or 4 minutes, whichever is less
            let halfDuration = duration / 2.0
            threshold = min(halfDuration, maxScrobbleThresholdSeconds)
        } else {
            // No duration info - use 4 minute default
            threshold = maxScrobbleThresholdSeconds
        }

        print("[ScrobbleManager] Play time: \(Int(totalPlayTime))s / threshold: \(Int(threshold))s")

        // Check if threshold met
        if totalPlayTime >= threshold {
            submitScrobble(for: track)
        }
    }

    private func sendPlayingNow(_ track: NowPlaying) {
        guard !playingNowSent else { return }

        guard let listen = ListenBrainzListen.from(nowPlaying: track) else {
            print("[ScrobbleManager] Could not create listen from track")
            return
        }

        playingNowSent = true

        listenBrainz.submitPlayingNow(listen) { result in
            switch result {
            case .success:
                print("[ScrobbleManager] Playing now sent successfully")
            case .failure(let error):
                print("[ScrobbleManager] Playing now failed: \(error.localizedDescription)")
            }
        }
    }

    private func submitScrobble(for track: NowPlaying) {
        guard !hasScrobbled else { return }
        hasScrobbled = true

        // Use the track start time as the scrobble timestamp
        let listenedAt = trackStartTime ?? Date()

        guard var listen = ListenBrainzListen.from(nowPlaying: track, listenedAt: listenedAt) else {
            print("[ScrobbleManager] Could not create listen from track")
            return
        }

        // Ensure we have the listened_at timestamp
        listen.listenedAt = Int(listenedAt.timeIntervalSince1970)

        print("[ScrobbleManager] Submitting scrobble: \(track.artist ?? "?") - \(track.title ?? "?")")

        listenBrainz.submitListen(listen) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success:
                    self?.scrobbleCount += 1
                    UserDefaults.standard.set(self?.scrobbleCount ?? 0, forKey: "scrobbleCount")
                    self?.lastScrobbledTrack = "\(track.artist ?? "") - \(track.title ?? "")"
                    print("[ScrobbleManager] Scrobble successful! Total: \(self?.scrobbleCount ?? 0)")
                case .failure(let error):
                    print("[ScrobbleManager] Scrobble failed: \(error.localizedDescription)")
                    // TODO: Queue for retry
                }
            }
        }

        // Stop the timer since we've scrobbled
        playbackTimer?.invalidate()
        playbackTimer = nil
    }
}
