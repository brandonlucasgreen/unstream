import Foundation
import Combine
import AppKit

// MARK: - MediaRemote Bridge (private framework for system NowPlaying)

/// Bridges to the private MediaRemote.framework to read system-level NowPlaying info.
/// This enables detection of any app that publishes to macOS Control Center (e.g. Tidal).
private struct MediaRemoteBridge {
    typealias MRMediaRemoteGetNowPlayingInfoFunction = @convention(c) (DispatchQueue, @escaping ([String: Any]) -> Void) -> Void
    typealias MRMediaRemoteGetNowPlayingClientFunction = @convention(c) (DispatchQueue, @escaping (AnyObject) -> Void) -> Void
    typealias MRNowPlayingClientGetBundleIdentifierFunction = @convention(c) (AnyObject?) -> String?
    typealias MRMediaRemoteGetNowPlayingApplicationIsPlayingFunction = @convention(c) (DispatchQueue, @escaping (Bool) -> Void) -> Void

    let getNowPlayingInfo: MRMediaRemoteGetNowPlayingInfoFunction?
    let getNowPlayingClient: MRMediaRemoteGetNowPlayingClientFunction?
    let getBundleIdentifier: MRNowPlayingClientGetBundleIdentifierFunction?
    let getIsPlaying: MRMediaRemoteGetNowPlayingApplicationIsPlayingFunction?

    static let shared: MediaRemoteBridge? = {
        let path = "/System/Library/PrivateFrameworks/MediaRemote.framework" as NSString
        guard let bundle = CFBundleCreate(kCFAllocatorDefault, NSURL(fileURLWithPath: path as String)) else {
            print("[MediaRemote] Failed to load MediaRemote.framework")
            return nil
        }

        func loadFunc<T>(_ name: String) -> T? {
            guard let ptr = CFBundleGetFunctionPointerForName(bundle, name as CFString) else {
                print("[MediaRemote] Failed to load function: \(name)")
                return nil
            }
            return unsafeBitCast(ptr, to: T.self)
        }

        let info: MRMediaRemoteGetNowPlayingInfoFunction? = loadFunc("MRMediaRemoteGetNowPlayingInfo")
        let client: MRMediaRemoteGetNowPlayingClientFunction? = loadFunc("MRMediaRemoteGetNowPlayingClient")
        let bundleId: MRNowPlayingClientGetBundleIdentifierFunction? = loadFunc("MRNowPlayingClientGetBundleIdentifier")
        let isPlaying: MRMediaRemoteGetNowPlayingApplicationIsPlayingFunction? = loadFunc("MRMediaRemoteGetNowPlayingApplicationIsPlaying")

        guard info != nil else {
            print("[MediaRemote] Could not load required functions")
            return nil
        }

        return MediaRemoteBridge(
            getNowPlayingInfo: info,
            getNowPlayingClient: client,
            getBundleIdentifier: bundleId,
            getIsPlaying: isPlaying
        )
    }()
}

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
            print("[MediaObserver] Got Music.app info: \(musicInfo.artist ?? "?") - \(musicInfo.title ?? "?") (\(musicInfo.duration ?? 0)s)")
            updateTrack((musicInfo.artist, musicInfo.title, musicInfo.album, musicInfo.duration, .appleMusic))
            return
        }

        // Then try Spotify
        if let spotifyInfo = getSpotifyNowPlaying() {
            print("[MediaObserver] Got Spotify info: \(spotifyInfo.artist ?? "?") - \(spotifyInfo.title ?? "?") (\(spotifyInfo.duration ?? 0)s)")
            updateTrack((spotifyInfo.artist, spotifyInfo.title, spotifyInfo.album, spotifyInfo.duration, .spotify))
            return
        }

        // Then try Radiccio
        if let radiccioInfo = getRadiccioNowPlaying() {
            print("[MediaObserver] Got Radiccio info: \(radiccioInfo.artist ?? "?") - \(radiccioInfo.title ?? "?") (\(radiccioInfo.duration ?? 0)s)")
            updateTrack((radiccioInfo.artist, radiccioInfo.title, radiccioInfo.album, radiccioInfo.duration, .radiccio))
            return
        }

        // Then try Parachord (Electron app — uses WebSocket API)
        if let parachordInfo = getParachordNowPlaying() {
            print("[MediaObserver] Got Parachord info: \(parachordInfo.artist ?? "?") - \(parachordInfo.title ?? "?") (\(parachordInfo.duration ?? 0)s)")
            updateTrack((parachordInfo.artist, parachordInfo.title, parachordInfo.album, parachordInfo.duration, .parachord))
            return
        }

        // Then try Tidal (via MediaRemote — no AppleScript dictionary)
        if let tidalInfo = getTidalNowPlaying() {
            print("[MediaObserver] Got Tidal info: \(tidalInfo.artist ?? "?") - \(tidalInfo.title ?? "?") (\(tidalInfo.duration ?? 0)s)")
            updateTrack((tidalInfo.artist, tidalInfo.title, tidalInfo.album, tidalInfo.duration, .tidal))
            return
        }

        // Then try Qobuz (Electron app — window title scraping)
        if let qobuzInfo = getQobuzNowPlaying() {
            print("[MediaObserver] Got Qobuz info: \(qobuzInfo.artist ?? "?") - \(qobuzInfo.title ?? "?") (\(qobuzInfo.duration ?? 0)s)")
            updateTrack((qobuzInfo.artist, qobuzInfo.title, qobuzInfo.album, qobuzInfo.duration, .qobuz))
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

    private func updateTrack(_ info: (artist: String?, title: String?, album: String?, duration: Double?, source: PlaybackSource)) {
        let nowPlaying = NowPlaying(
            title: info.title,
            artist: info.artist,
            album: info.album,
            artworkData: nil,
            durationSeconds: info.duration,
            source: info.source
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

    private func getMusicAppNowPlaying() -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        // First check if Music is running using System Events
        let checkScript = "tell application \"System Events\" to return (exists process \"Music\")"
        guard let result = runAppleScript(checkScript, silent: true), result == "true" else {
            return nil // Music not running or can't check
        }

        // Check if music is playing and get track info including duration
        let infoScript = """
            tell application "Music"
                if player state is playing then
                    set theArtist to artist of current track
                    set theTitle to name of current track
                    set theAlbum to album of current track
                    set theDuration to duration of current track
                    return theArtist & "|||" & theTitle & "|||" & theAlbum & "|||" & theDuration
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

    private func getSpotifyNowPlaying() -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        let checkScript = "tell application \"System Events\" to return (exists process \"Spotify\")"
        guard let result = runAppleScript(checkScript, silent: true), result == "true" else {
            return nil
        }

        // Spotify returns duration in milliseconds, so we convert to seconds
        let infoScript = """
            tell application "Spotify"
                if player state is playing then
                    set theArtist to artist of current track
                    set theTitle to name of current track
                    set theAlbum to album of current track
                    set theDuration to (duration of current track) / 1000
                    return theArtist & "|||" & theTitle & "|||" & theAlbum & "|||" & theDuration
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

    private func getRadiccioNowPlaying() -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        let checkScript = "tell application \"System Events\" to return (exists process \"Radiccio\")"
        guard let result = runAppleScript(checkScript, silent: true), result == "true" else {
            return nil
        }

        let infoScript = """
            tell application "Radiccio"
                if player state is playing then
                    set theTrack to current track
                    set theArtist to artist of theTrack
                    set theTitle to title of theTrack
                    set theAlbum to album of theTrack
                    set theDuration to duration of theTrack
                    return theArtist & "|||" & theTitle & "|||" & theAlbum & "|||" & theDuration
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

    private func getParachordNowPlaying() -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        let checkScript = "tell application \"System Events\" to return (exists process \"Parachord\")"
        guard let result = runAppleScript(checkScript, silent: true), result == "true" else {
            return nil
        }

        // Parachord is an Electron app with a WebSocket API on port 9876.
        // Connect as an "embed" client and request playback state.
        return getParachordStateViaWebSocket()
    }

    private func getParachordStateViaWebSocket() -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        guard let url = URL(string: "ws://127.0.0.1:9876") else { return nil }

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        task.resume()

        defer { task.cancel(with: .goingAway, reason: nil) }

        let semaphore = DispatchSemaphore(value: 0)
        var trackInfo: (artist: String?, title: String?, album: String?, duration: Double?)? = nil

        // Send embed registration + getState request
        let request = "{\"type\":\"embed\",\"action\":\"getState\",\"requestId\":\"unstream\"}"
        task.send(.string(request)) { error in
            if error != nil { semaphore.signal() }
        }

        // Receive response
        task.receive { result in
            defer { semaphore.signal() }
            guard case .success(let message) = result,
                  case .string(let text) = message,
                  let data = text.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  json["success"] as? Bool == true,
                  json["isPlaying"] as? Bool == true,
                  let track = json["currentTrack"] as? [String: Any] else {
                return
            }

            let artist = track["artist"] as? String
            let title = track["title"] as? String
            let album = track["album"] as? String
            let duration = track["duration"] as? Double

            if artist != nil || title != nil {
                trackInfo = (artist, title, album, duration)
            }
        }

        _ = semaphore.wait(timeout: .now() + 2.0)
        return trackInfo
    }


    // MARK: - Tidal (via MediaRemote)

    /// Bundle IDs to match for MediaRemote-based detection, mapped to PlaybackSource
    private static let mediaRemoteSources: [(bundleId: String, source: PlaybackSource)] = [
        ("com.tidal.desktop", .tidal),
    ]

    private func getTidalNowPlaying() -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        // First check if TIDAL process is running
        let checkScript = "tell application \"System Events\" to return (exists process \"TIDAL\")"
        guard let result = runAppleScript(checkScript, silent: true), result == "true" else {
            return nil
        }

        return getMediaRemoteNowPlaying(forBundleId: "com.tidal.desktop")
    }

    /// Reads NowPlaying info from the system MediaRemote framework, filtered to a specific bundle ID.
    private func getMediaRemoteNowPlaying(forBundleId targetBundleId: String) -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        guard let bridge = MediaRemoteBridge.shared else { return nil }

        let semaphore = DispatchSemaphore(value: 0)
        var trackInfo: (artist: String?, title: String?, album: String?, duration: Double?)? = nil

        // First check which app is currently the NowPlaying client
        let clientSemaphore = DispatchSemaphore(value: 0)
        var currentBundleId: String? = nil

        bridge.getNowPlayingClient?(DispatchQueue.global(qos: .userInitiated)) { client in
            currentBundleId = bridge.getBundleIdentifier?(client)
            clientSemaphore.signal()
        }
        _ = clientSemaphore.wait(timeout: .now() + 2.0)

        // Only proceed if the target app is the active NowPlaying source
        guard currentBundleId == targetBundleId else { return nil }

        // Check if actually playing
        var isPlaying = false
        let playingSemaphore = DispatchSemaphore(value: 0)
        bridge.getIsPlaying?(DispatchQueue.global(qos: .userInitiated)) { playing in
            isPlaying = playing
            playingSemaphore.signal()
        }
        _ = playingSemaphore.wait(timeout: .now() + 2.0)

        guard isPlaying else { return nil }

        // Get track metadata
        bridge.getNowPlayingInfo?(DispatchQueue.global(qos: .userInitiated)) { info in
            let artist = info["kMRMediaRemoteNowPlayingInfoArtist"] as? String
            let title = info["kMRMediaRemoteNowPlayingInfoTitle"] as? String
            let album = info["kMRMediaRemoteNowPlayingInfoAlbum"] as? String
            let duration = info["kMRMediaRemoteNowPlayingInfoDuration"] as? Double

            if artist != nil || title != nil {
                trackInfo = (artist, title, album, duration)
            }
            semaphore.signal()
        }

        _ = semaphore.wait(timeout: .now() + 2.0)
        return trackInfo
    }

    // MARK: - Qobuz (window title scraping)

    private func getQobuzNowPlaying() -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        // First check if Qobuz is running
        let checkScript = "tell application \"System Events\" to return (exists process \"Qobuz\")"
        guard let result = runAppleScript(checkScript, silent: true), result == "true" else {
            return nil
        }

        // Try MediaRemote first (works on some Qobuz versions)
        if let mediaRemoteInfo = getMediaRemoteNowPlaying(forBundleId: "com.qobuz.desktop") {
            return mediaRemoteInfo
        }

        // Fallback: scrape window title — Qobuz shows "Artist - Track" in the title bar
        let titleScript = """
            tell application "System Events"
                tell process "Qobuz"
                    set windowTitle to name of front window
                    return windowTitle
                end tell
            end tell
            """

        guard let windowTitle = runAppleScript(titleScript, silent: true),
              !windowTitle.isEmpty,
              windowTitle != "Qobuz" else {
            return nil
        }

        // Qobuz window title format is typically "Artist - Track Title" or "Track Title - Artist"
        // Some versions use " - " as delimiter
        let parts = windowTitle.components(separatedBy: " - ")
        guard parts.count >= 2 else {
            return nil
        }

        // Convention from Windows scrobblers: first part is artist, second is track
        let artist = parts[0].trimmingCharacters(in: .whitespaces)
        let title = parts.dropFirst().joined(separator: " - ").trimmingCharacters(in: .whitespaces)

        guard !artist.isEmpty, !title.isEmpty else { return nil }

        return (artist, title, nil, nil)
    }

    // MARK: - AppleScript Helpers

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

    private func parseTrackInfo(_ output: String?) -> (artist: String?, title: String?, album: String?, duration: Double?)? {
        guard let output = output, !output.isEmpty else {
            return nil
        }

        let parts = output.components(separatedBy: "|||")
        guard parts.count >= 3 else {
            return nil
        }

        // Parse duration if available (4th field)
        var duration: Double? = nil
        if parts.count >= 4, let durationValue = Double(parts[3].trimmingCharacters(in: .whitespaces)) {
            duration = durationValue
        }

        return (
            parts[0].isEmpty ? nil : parts[0],
            parts[1].isEmpty ? nil : parts[1],
            parts[2].isEmpty ? nil : parts[2],
            duration
        )
    }
}
