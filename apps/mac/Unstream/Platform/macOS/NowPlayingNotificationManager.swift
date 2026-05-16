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
        let platforms = topResult.verifiedPlatforms
        guard !platforms.isEmpty else { return }

        let artistSlug = topResult.claimedSlug ?? slugify(artist)
        let artistUrl = "https://unstream.stream/a/\(artistSlug)"

        let content = UNMutableNotificationContent()
        content.title = artist
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

    private func slugify(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    private func buildBody(platforms: [PlatformResult]) -> String {
        switch platforms.count {
        case 1:
            return "Available on \(platforms[0].displayName)"
        case 2:
            return "Available on \(platforms[0].displayName) and \(platforms[1].displayName)"
        default:
            let extra = platforms.count - 2
            return "Available on \(platforms[0].displayName), \(platforms[1].displayName), and \(extra) more"
        }
    }
}
#endif
