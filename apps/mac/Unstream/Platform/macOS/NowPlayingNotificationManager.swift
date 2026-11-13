#if os(macOS)
import Foundation
import UserNotifications

@MainActor
class NowPlayingNotificationManager {
    static let enabledKey = "artistNotificationsEnabled"

    var isEnabled: Bool {
        get {
            // Default true: unset key (new install or upgrade) returns true
            UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.enabledKey)
        }
    }

    // Reset on each app launch — not persisted
    private var notifiedArtistsThisSession: Set<String> = []

    func handleArtistDetected(_ artist: String, results: [ArtistResult]) async {
        guard isEnabled else { return }
        guard !artist.isEmpty else { return }

        let key = artist.lowercased()
        guard !notifiedArtistsThisSession.contains(key) else { return }
        notifiedArtistsThisSession.insert(key)

        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()

        switch settings.authorizationStatus {
        case .authorized, .provisional:
            await sendNotification(for: artist, results: results)
        case .notDetermined:
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
            if granted {
                await sendNotification(for: artist, results: results)
            }
        default:
            break
        }
    }

    private func sendNotification(for artist: String, results: [ArtistResult]) async {
        guard let topResult = results.first else { return }
        let platforms = topResult.marketplacePlatforms
        guard !platforms.isEmpty else { return }

        let artistSlug = topResult.claimedSlug ?? slugify(artist)
        let artistUrl = notificationURL(for: artist, claimedSlug: topResult.claimedSlug)

        let content = UNMutableNotificationContent()
        content.title = "Now playing: \(artist)"
        content.body = buildBody(platforms: platforms)
        content.sound = .default
        content.userInfo = ["artistUrl": artistUrl]

        let request = UNNotificationRequest(
            identifier: "nowPlaying-\(artistSlug)",
            content: content,
            trigger: nil
        )
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// Where clicking the notification goes: the artist's page when they have a claimed one,
    /// otherwise a search. Never `/a/<slugified name>`: an artist's slug isn't always their name
    /// (Impulse Nine is `impulsenine`), and a guessed one is a dead page that search engines
    /// then report as a soft 404.
    private func notificationURL(for artist: String, claimedSlug: String?) -> String {
        if let claimedSlug {
            return "https://unstream.stream/a/\(claimedSlug)"
        }
        var components = URLComponents(string: "https://unstream.stream/")!
        components.queryItems = [URLQueryItem(name: "q", value: artist)]
        return components.url?.absoluteString ?? "https://unstream.stream"
    }

    /// Identifies the notification, so one artist isn't announced twice. Not a URL.
    private func slugify(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    private func buildBody(platforms: [PlatformResult]) -> String {
        switch platforms.count {
        case 1:
            return "Support directly on \(platforms[0].displayName)"
        case 2:
            return "Support directly on \(platforms[0].displayName) and \(platforms[1].displayName)"
        default:
            let extra = platforms.count - 1
            return "Support directly on \(platforms[0].displayName) and \(extra) other platforms"
        }
    }
}
#endif
