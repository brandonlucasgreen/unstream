import Foundation
import UserNotifications

/// Manages release alert checking, scheduling, and notifications
@MainActor
class ReleaseAlertManager: ObservableObject {
    // MARK: - Published Properties

    @Published private(set) var newReleases: [NewRelease] = []
    @Published private(set) var isChecking: Bool = false
    @Published private(set) var lastCheckDate: Date?

    // MARK: - Private Properties

    private var checkState: ReleaseCheckState
    private var checkTimer: Timer?
    private let storageKey = "releaseCheckState"

    private let releaseAPI = ReleaseCheckAPI()

    private weak var supportListManager: SupportListManager?
    private weak var licenseManager: LicenseManager?

    // MARK: - Settings

    @Published var releaseAlertsEnabled: Bool {
        didSet {
            UserDefaults.standard.set(releaseAlertsEnabled, forKey: "releaseAlertsEnabled")
            if releaseAlertsEnabled {
                setupScheduling()
            } else {
                checkTimer?.invalidate()
                checkTimer = nil
            }
        }
    }

    // MARK: - Initialization

    init(supportListManager: SupportListManager, licenseManager: LicenseManager) {
        self.supportListManager = supportListManager
        self.licenseManager = licenseManager
        self.releaseAlertsEnabled = UserDefaults.standard.bool(forKey: "releaseAlertsEnabled")
        self.checkState = Self.loadState()
        self.newReleases = checkState.newReleases.filter { $0.isActive }
        self.lastCheckDate = checkState.lastCheckDate

        setupScheduling()
    }

    // MARK: - Public Methods

    /// Get the new release for a specific artist, if any
    func newRelease(for artistName: String) -> NewRelease? {
        newReleases.first { $0.artistName.lowercased() == artistName.lowercased() && $0.isActive }
    }

    /// Dismiss a new release notification
    func dismissRelease(_ release: NewRelease) {
        newReleases.removeAll { $0.id == release.id }
        checkState.newReleases.removeAll { $0.id == release.id }
        saveState()
    }

    /// Manually trigger a release check (for testing/debugging)
    func checkNow() async {
        await checkForNewReleases()
    }

    #if DEBUG
    /// Clear all known releases (for testing - allows re-detecting releases)
    func clearKnownReleases() {
        checkState.knownReleases = [:]
        checkState.newReleases = []
        newReleases = []
        saveState()
    }

    /// Clear all state including last check date (full reset for testing)
    func resetAllState() {
        checkState = ReleaseCheckState()
        newReleases = []
        lastCheckDate = nil
        saveState()
    }
    #endif

    /// Request notification permission
    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                print("Notification permission error: \(error)")
            }
        }
    }

    // MARK: - Scheduling

    private func setupScheduling() {
        guard licenseManager?.isPro == true, releaseAlertsEnabled else { return }

        // Prune expired releases
        checkState.pruneExpiredReleases()
        newReleases = checkState.newReleases.filter { $0.isActive }
        saveState()

        if let lastCheck = checkState.lastCheckDate {
            let daysSinceLastCheck = Date().timeIntervalSince(lastCheck) / (24 * 60 * 60)

            if daysSinceLastCheck >= 7 {
                // More than 7 days since last check - check immediately
                Task {
                    await checkForNewReleases()
                }
            } else {
                // Schedule for next Friday 9am
                scheduleNextFriday9am()
            }
        } else {
            // First run - initialize state and schedule (only track going forward)
            checkState.lastCheckDate = Date()
            saveState()
            scheduleNextFriday9am()
        }
    }

    private func scheduleNextFriday9am() {
        checkTimer?.invalidate()

        guard let nextFriday = calculateNextFriday9am() else { return }

        let interval = nextFriday.timeIntervalSinceNow

        // If the interval is negative or too small, schedule for next week
        guard interval > 60 else {
            // Schedule for next week's Friday
            if let nextWeekFriday = Calendar.current.date(byAdding: .day, value: 7, to: nextFriday) {
                let nextWeekInterval = nextWeekFriday.timeIntervalSinceNow
                checkTimer = Timer.scheduledTimer(withTimeInterval: nextWeekInterval, repeats: false) { [weak self] _ in
                    Task { @MainActor [weak self] in
                        await self?.checkForNewReleases()
                    }
                }
            }
            return
        }

        checkTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.checkForNewReleases()
            }
        }
    }

    private func calculateNextFriday9am() -> Date? {
        let calendar = Calendar.current
        let now = Date()

        // Find the next Friday
        var components = calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: now)
        components.weekday = 6 // Friday (1 = Sunday)
        components.hour = 9
        components.minute = 0
        components.second = 0

        guard var nextFriday = calendar.date(from: components) else { return nil }

        // If this Friday has passed, get next week's Friday
        if nextFriday <= now {
            nextFriday = calendar.date(byAdding: .day, value: 7, to: nextFriday) ?? nextFriday
        }

        return nextFriday
    }

    // MARK: - Release Checking

    private func checkForNewReleases() async {
        guard let supportListManager = supportListManager,
              licenseManager?.isPro == true,
              releaseAlertsEnabled else { return }

        isChecking = true
        defer {
            isChecking = false
            checkState.lastCheckDate = Date()
            lastCheckDate = checkState.lastCheckDate
            saveState()
            scheduleNextFriday9am()
        }

        let entries = supportListManager.entries
        var foundNewReleases: [NewRelease] = []

        for entry in entries {
            // Build platforms dictionary for API call
            var platforms: [String: String] = [:]

            if let bandcampUrl = entry.platforms.first(where: { $0.sourceId == "bandcamp" })?.url {
                platforms["bandcamp"] = bandcampUrl
            }
            if let faircampUrl = entry.platforms.first(where: { $0.sourceId == "faircamp" })?.url {
                platforms["faircamp"] = faircampUrl
            }
            if let mirloUrl = entry.platforms.first(where: { $0.sourceId == "mirlo" })?.url {
                platforms["mirlo"] = mirloUrl
            }
            if let qobuzUrl = entry.platforms.first(where: { $0.sourceId == "qobuz" })?.url {
                platforms["qobuz"] = qobuzUrl
            }

            // Skip if no supported platforms
            guard !platforms.isEmpty else { continue }

            // Call API to check for releases (API handles priority internally)
            if let release = await checkViaAPI(artistName: entry.artistName, platforms: platforms) {
                foundNewReleases.append(release)
            }
        }

        // Update state with new releases
        if !foundNewReleases.isEmpty {
            var releasesToNotify: [NewRelease] = []
            for release in foundNewReleases {
                let alreadyKnown = newReleases.contains(where: { $0.artistName.lowercased() == release.artistName.lowercased() })
                if !alreadyKnown {
                    newReleases.append(release)
                    checkState.newReleases.append(release)
                    releasesToNotify.append(release)
                }
            }

            // Save state and wait for UI to update before sending notifications
            saveState()

            // Small delay to ensure SwiftUI has time to update the UI
            try? await Task.sleep(nanoseconds: 500_000_000) // 0.5 seconds

            // Send individual notifications for each new release
            if !releasesToNotify.isEmpty {
                await sendNotifications(for: releasesToNotify)
            }
        }
    }

    private func checkViaAPI(artistName: String, platforms: [String: String]) async -> NewRelease? {
        do {
            guard let result = try await releaseAPI.checkReleases(artistName: artistName, platforms: platforms) else {
                return nil
            }

            // Check if we already know about this release (on ANY platform)
            if checkState.isKnownReleaseByName(result.releaseName, for: artistName) {
                return nil
            }

            // Mark as known
            checkState.addKnownRelease(
                KnownRelease(releaseName: result.releaseName, releaseDate: result.releaseDate, platform: result.platform),
                for: artistName
            )

            return NewRelease(
                artistName: artistName,
                releaseName: result.releaseName,
                releaseDate: result.releaseDate,
                releaseUrl: result.releaseUrl,
                platform: result.platform
            )
        } catch {
            print("API check failed for \(artistName): \(error)")
            return nil
        }
    }

    // MARK: - Notifications

    private func sendNotifications(for releases: [NewRelease]) async {
        // Check authorization status first
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized else { return }

        // Send individual notification for each release
        for release in releases {

            let content = UNMutableNotificationContent()
            content.title = "New Release from \(release.artistName)"
            content.body = "\"\(release.releaseName)\" is out now on \(release.platform.capitalized)!"
            content.sound = .default
            content.userInfo = ["releaseUrl": release.releaseUrl]

            let request = UNNotificationRequest(
                identifier: "releaseAlert-\(release.id.uuidString)",
                content: content,
                trigger: nil
            )

            do {
                try await UNUserNotificationCenter.current().add(request)
            } catch {
                print("Failed to send notification for \(release.artistName): \(error)")
            }
        }
    }

    // MARK: - Persistence

    private static func loadState() -> ReleaseCheckState {
        guard let data = UserDefaults.standard.data(forKey: "releaseCheckState"),
              let state = try? JSONDecoder().decode(ReleaseCheckState.self, from: data) else {
            return ReleaseCheckState()
        }
        return state
    }

    private func saveState() {
        if let data = try? JSONEncoder().encode(checkState) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
    }
}
