import Foundation

/// Checks for app updates from a remote server
actor UpdateChecker {
    static let shared = UpdateChecker()

    // URL where version info is hosted - update this to your actual URL
    private let versionURL = URL(string: "https://unstream.stream/api/desktop/version")!

    private var lastCheckTime: Date?
    private let checkInterval: TimeInterval = 86400 // Check once per day

    struct VersionInfo: Codable {
        let latestVersion: String
        let downloadUrl: String
        let releaseNotes: String?
    }

    func checkForUpdates() async throws -> String {
        let (data, _) = try await URLSession.shared.data(from: versionURL)
        let versionInfo = try JSONDecoder().decode(VersionInfo.self, from: data)

        let currentVersion = Bundle.main.appVersion
        lastCheckTime = Date()

        if isNewerVersion(versionInfo.latestVersion, than: currentVersion) {
            return "Update available: v\(versionInfo.latestVersion)"
        } else {
            return "You're up to date (v\(currentVersion))"
        }
    }

    func checkForUpdatesIfNeeded() async {
        // Only check if enough time has passed
        if let lastCheck = lastCheckTime,
           Date().timeIntervalSince(lastCheck) < checkInterval {
            return
        }

        do {
            let status = try await checkForUpdates()
            if status.contains("available") {
                // Could show a notification here
                print("[UpdateChecker] \(status)")
            }
        } catch {
            print("[UpdateChecker] Failed to check for updates: \(error)")
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
