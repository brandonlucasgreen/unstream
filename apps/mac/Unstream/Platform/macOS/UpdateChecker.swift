import Foundation
import UserNotifications

/// Checks for app updates from a remote server.
///
/// The Mac app ships as a direct GitHub release rather than through the Mac App Store,
/// so it is responsible for telling people an update exists.
actor UpdateChecker {
    static let shared = UpdateChecker()

    // URL where version info is hosted - update this to your actual URL
    private let versionURL = URL(string: "https://unstream.stream/api/desktop/version")!

    private let checkInterval: TimeInterval = 86400 // Check once per day

    /// Persisted, not in-memory: this is a menu bar app that gets relaunched often, and
    /// an in-memory timestamp meant "once a day" was really "every single launch".
    private static let lastCheckKey = "updateCheckerLastCheckTime"
    /// Suppresses repeat notifications for a version the user has already been told about.
    private static let notifiedVersionKey = "updateCheckerNotifiedVersion"

    private var lastCheckTime: Date? {
        get {
            let stamp = UserDefaults.standard.double(forKey: Self.lastCheckKey)
            return stamp > 0 ? Date(timeIntervalSince1970: stamp) : nil
        }
        set {
            UserDefaults.standard.set(newValue?.timeIntervalSince1970 ?? 0, forKey: Self.lastCheckKey)
        }
    }

    struct VersionInfo: Codable {
        let latestVersion: String
        let downloadUrl: String
        let releaseNotes: String?
    }

    struct UpdateResult {
        let message: String
        let updateAvailable: Bool
        let downloadUrl: String?
        let latestVersion: String?
    }

    func checkForUpdates() async throws -> UpdateResult {
        let (data, _) = try await URLSession.shared.data(from: versionURL)
        let versionInfo = try JSONDecoder().decode(VersionInfo.self, from: data)

        let currentVersion = Bundle.main.appVersion
        lastCheckTime = Date()

        if isNewerVersion(versionInfo.latestVersion, than: currentVersion) {
            return UpdateResult(
                message: "Update available: v\(versionInfo.latestVersion)",
                updateAvailable: true,
                downloadUrl: versionInfo.downloadUrl,
                latestVersion: versionInfo.latestVersion
            )
        } else {
            return UpdateResult(
                message: "You're up to date! (v\(currentVersion))",
                updateAvailable: false,
                downloadUrl: nil,
                latestVersion: nil
            )
        }
    }

    /// Background check honouring the "Check for updates automatically" setting.
    /// Called at launch; safe to call more often, since the interval gates the work.
    func checkForUpdatesIfNeeded() async {
        guard UserDefaults.standard.object(forKey: "checkForUpdatesAutomatically") == nil
                || UserDefaults.standard.bool(forKey: "checkForUpdatesAutomatically") else {
            return
        }

        // Only check if enough time has passed
        if let lastCheck = lastCheckTime,
           Date().timeIntervalSince(lastCheck) < checkInterval {
            return
        }

        do {
            let result = try await checkForUpdates()
            guard result.updateAvailable, let version = result.latestVersion else { return }

            // Don't re-notify for a version we've already surfaced.
            guard UserDefaults.standard.string(forKey: Self.notifiedVersionKey) != version else { return }
            UserDefaults.standard.set(version, forKey: Self.notifiedVersionKey)

            await notify(version: version, downloadUrl: result.downloadUrl)
        } catch {
            print("[UpdateChecker] Failed to check for updates: \(error)")
        }
    }

    /// A print statement is not a feature: without this, "check automatically" did the
    /// network request and then told nobody.
    private func notify(version: String, downloadUrl: String?) async {
        let center = UNUserNotificationCenter.current()

        // Piggyback on whatever authorization the app already holds rather than
        // prompting for notifications on launch just to mention an update.
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else {
            print("[UpdateChecker] Update \(version) available; notifications not authorized")
            return
        }

        let content = UNMutableNotificationContent()
        content.title = "Unstream \(version) is available"
        content.body = "You're on \(Bundle.main.appVersion). Click to download the update."
        if let downloadUrl {
            content.userInfo = ["updateUrl": downloadUrl]
        }

        let request = UNNotificationRequest(
            identifier: "unstream-update-\(version)",
            content: content,
            trigger: nil
        )

        do {
            try await center.add(request)
        } catch {
            print("[UpdateChecker] Failed to post update notification: \(error)")
        }
    }

    /// Compare version strings (e.g., "1.0.1" > "1.0.0")
    private func isNewerVersion(_ new: String, than current: String) -> Bool {
        let newParts = new.split(separator: ".").compactMap { Int($0) }
        let currentParts = current.split(separator: ".").compactMap { Int($0) }

        for i in 0..<max(newParts.count, currentParts.count) {
            let newPart = i < newParts.count ? newParts[i] : 0
            let currentPart = i < currentParts.count ? currentParts[i] : 0

            if newPart > currentPart {
                return true
            } else if newPart < currentPart {
                return false
            }
        }

        return false
    }
}

// Bundle.appVersion is defined in SettingsView.swift
