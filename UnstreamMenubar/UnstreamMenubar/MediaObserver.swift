import Foundation
import Combine
import AppKit

/// Observes Now Playing information using AppleScript to query Music.app
class MediaObserver: ObservableObject {
    @Published var currentTrack: NowPlaying?
    @Published var permissionStatus: String = "Checking..."
    @Published var isListeningEnabled: Bool = true

    private var timer: Timer?
    private let pollInterval: TimeInterval = 5.0 // Poll every 5 seconds for lower CPU usage
    private var lastArtist: String? = nil // Track last artist to avoid redundant updates

    init() {
        // Check if listening is enabled in settings
        isListeningEnabled = UserDefaults.standard.object(forKey: "musicListeningEnabled") as? Bool ?? true

        // Listen for settings changes
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(settingsChanged),
            name: UserDefaults.didChangeNotification,
            object: nil
        )

        // Delay starting the polling to let the app fully launch first
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.checkPermissionsAndStart()
        }
    }

    @objc private func settingsChanged() {
        let newValue = UserDefaults.standard.object(forKey: "musicListeningEnabled") as? Bool ?? true
        if newValue != isListeningEnabled {
            isListeningEnabled = newValue
            if newValue {
                print("[MediaObserver] Listening enabled")
                startPolling()
            } else {
                print("[MediaObserver] Listening disabled")
                stopPolling()
                DispatchQueue.main.async {
                    self.currentTrack = nil
                }
            }
        }
    }

    deinit {
        stopPolling()
    }

    private func checkPermissionsAndStart() {
        guard isListeningEnabled else {
            print("[MediaObserver] Listening disabled, skipping")
            return
        }

        print("[MediaObserver] Checking automation permissions...")

        // This simple script should trigger the permission dialog if not granted
        let testScript = "tell application \"System Events\" to return name of first process"

        if let script = NSAppleScript(source: testScript) {
            var errorDict: NSDictionary?
            let result = script.executeAndReturnError(&errorDict)

            if let error = errorDict {
                let errorNum = error["NSAppleScriptErrorNumber"] as? Int ?? 0
                let errorMsg = error["NSAppleScriptErrorMessage"] as? String ?? "Unknown error"
                print("[MediaObserver] Permission check failed: \(errorNum) - \(errorMsg)")

                if errorNum == -1743 {
                    // Permission denied
                    DispatchQueue.main.async {
                        self.permissionStatus = "Permission denied. Please enable in System Settings > Privacy & Security > Automation"
                    }
                    print("[MediaObserver] ERROR: Automation permission denied!")
                    print("[MediaObserver] Please go to System Settings > Privacy & Security > Automation")
                    print("[MediaObserver] And enable 'Unstream' to control 'System Events' and 'Music'")
                    return
                }
            } else {
                print("[MediaObserver] System Events access OK: \(result.stringValue ?? "success")")
            }
        }

        DispatchQueue.main.async {
            self.permissionStatus = "OK"
        }

        startPolling()
    }

    func startPolling() {
        print("[MediaObserver] Starting to poll for music...")

        // Set up polling timer
        timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.fetchNowPlayingAsync()
        }

        // Do first fetch
        fetchNowPlayingAsync()
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    private func fetchNowPlayingAsync() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.fetchNowPlaying()
        }
    }

    private func fetchNowPlaying() {
        // Try Music.app first
        if let musicInfo = getMusicAppNowPlaying() {
            print("[MediaObserver] Got Music.app info: \(musicInfo)")
            updateTrack(musicInfo)
            return
        }

        // Then try Spotify
        if let spotifyInfo = getSpotifyNowPlaying() {
            print("[MediaObserver] Got Spotify info: \(spotifyInfo)")
            updateTrack(spotifyInfo)
            return
        }

        // No music playing
        DispatchQueue.main.async { [weak self] in
            if self?.currentTrack != nil {
                print("[MediaObserver] No music detected, clearing track")
                self?.currentTrack = nil
            }
        }
    }

    private func updateTrack(_ info: (artist: String?, title: String?, album: String?)) {
        let nowPlaying = NowPlaying(
            title: info.title,
            artist: info.artist,
            album: info.album,
            artworkData: nil
        )

        guard nowPlaying.hasContent else { return }

        // Only update if something changed (reduces unnecessary UI updates)
        let artistChanged = info.artist?.lowercased() != lastArtist?.lowercased()
        let titleChanged = currentTrack?.title != info.title

        if artistChanged || titleChanged || currentTrack == nil {
            if artistChanged {
                print("[MediaObserver] Artist changed: \(info.artist ?? "unknown")")
                lastArtist = info.artist
            }

            DispatchQueue.main.async { [weak self] in
                self?.currentTrack = nowPlaying
            }
        }
    }

    private func getMusicAppNowPlaying() -> (artist: String?, title: String?, album: String?)? {
        // First check if Music is running using System Events
        let checkScript = "tell application \"System Events\" to return (exists process \"Music\")"
        guard let result = runAppleScript(checkScript, silent: true), result == "true" else {
            return nil // Music not running or can't check
        }

        // Check if music is playing and get track info
        let infoScript = """
            tell application "Music"
                if player state is playing then
                    set theArtist to artist of current track
                    set theTitle to name of current track
                    set theAlbum to album of current track
                    return theArtist & "|||" & theTitle & "|||" & theAlbum
                else
                    return "not_playing"
                end if
            end tell
            """

        guard let info = runAppleScript(infoScript) else {
            print("[MediaObserver] Failed to get track info from Music")
            return nil
        }

        if info == "not_playing" {
            print("[MediaObserver] Music.app is paused")
            return nil
        }

        return parseTrackInfo(info)
    }

    private func getSpotifyNowPlaying() -> (artist: String?, title: String?, album: String?)? {
        let checkScript = "tell application \"System Events\" to return (exists process \"Spotify\")"
        guard let result = runAppleScript(checkScript, silent: true), result == "true" else {
            return nil
        }

        let infoScript = """
            tell application "Spotify"
                if player state is playing then
                    set theArtist to artist of current track
                    set theTitle to name of current track
                    set theAlbum to album of current track
                    return theArtist & "|||" & theTitle & "|||" & theAlbum
                else
                    return "not_playing"
                end if
            end tell
            """

        guard let info = runAppleScript(infoScript), info != "not_playing" else {
            return nil
        }

        return parseTrackInfo(info)
    }

    private func runAppleScript(_ source: String, silent: Bool = false) -> String? {
        guard let script = NSAppleScript(source: source) else {
            if !silent { print("[MediaObserver] Failed to create script") }
            return nil
        }

        var errorDict: NSDictionary?
        let result = script.executeAndReturnError(&errorDict)

        if let error = errorDict {
            let errorNum = error["NSAppleScriptErrorNumber"] as? Int ?? 0
            let errorMsg = error["NSAppleScriptErrorMessage"] as? String ?? ""
            // Only log errors if not silent, and skip common "app not running" errors (-600)
            if !silent && errorNum != 0 && errorNum != -600 {
                print("[MediaObserver] Script error \(errorNum): \(errorMsg)")
            }
            return nil
        }

        return result.stringValue
    }

    private func parseTrackInfo(_ output: String?) -> (artist: String?, title: String?, album: String?)? {
        guard let output = output, !output.isEmpty else {
            return nil
        }

        let parts = output.components(separatedBy: "|||")
        guard parts.count >= 3 else {
            return nil
        }

        return (
            parts[0].isEmpty ? nil : parts[0],
            parts[1].isEmpty ? nil : parts[1],
            parts[2].isEmpty ? nil : parts[2]
        )
    }
}
