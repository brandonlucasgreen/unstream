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
    private let iCloudStore = NSUbiquitousKeyValueStore.default
    private let dismissedIdsKey = "dismissedReleaseIds"

    private weak var supportListManager: SupportListManager?

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

    init(supportListManager: SupportListManager) {
        self.supportListManager = supportListManager
        self.releaseAlertsEnabled = UserDefaults.standard.bool(forKey: "releaseAlertsEnabled")
        self.checkState = Self.loadState()

        // Filter out releases that were dismissed on another device via iCloud
        let dismissedIds = loadDismissedIds()
        self.newReleases = checkState.newReleases.filter { $0.isActive && !dismissedIds.contains($0.id) }
        self.lastCheckDate = checkState.lastCheckDate

        setupDismissedIdSync()
        setupScheduling()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Public Methods

    /// Get the new release for a specific artist, if any
    func newRelease(for artistName: String) -> NewRelease? {
        newReleases.first { $0.artistName.lowercased() == artistName.lowercased() && $0.isActive }
    }

    /// Dismiss a new release notification (syncs dismissed state via iCloud KVS)
    func dismissRelease(_ release: NewRelease) {
        newReleases.removeAll { $0.id == release.id }
        checkState.newReleases.removeAll { $0.id == release.id }
        saveDismissedId(release.id)
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
        guard releaseAlertsEnabled else { return }

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
            // Skip if no supported platforms
            guard !platforms.isEmpty else { continue }

            // The server returns every release in the window, not just the newest, so an artist
            // who put out two records since the last check produces two alerts.
            foundNewReleases.append(contentsOf: await checkViaAPI(artistName: entry.artistName, platforms: platforms))
        }

        // Update state with new releases.
        //
        // There is deliberately no second dedup here. There used to be one — it asked whether
        // the display list already held *any* release by this artist, and skipped the release if
        // so. That was wrong in a way that lost data permanently: checkViaAPI has already done
        // the correct per-release dedup and has already recorded the release as known, so an
        // artist's genuinely-new second record was dropped from both the list and the
        // notification while being marked as seen — making it undetectable forever after.
        if !foundNewReleases.isEmpty {
            newReleases.append(contentsOf: foundNewReleases)
            checkState.newReleases.append(contentsOf: foundNewReleases)

            // Save state and wait for UI to update before sending notifications
            saveState()

            // Small delay to ensure SwiftUI has time to update the UI
            try? await Task.sleep(nanoseconds: 500_000_000) // 0.5 seconds

            await sendNotifications(for: foundNewReleases)
        }
    }

    /// Ask the server what's new for one artist, and keep only what we haven't seen before.
    private func checkViaAPI(artistName: String, platforms: [String: String]) async -> [NewRelease] {
        do {
            let results = try await releaseAPI.checkReleases(artistName: artistName, platforms: platforms)
            return Self.selectUnseen(results, artistName: artistName, state: &checkState)
        } catch {
            print("API check failed for \(artistName): \(error)")
            return []
        }
    }

    /// Which of these results haven't we alerted on before? Marks each one it returns as known.
    ///
    /// **This is the only dedup point, and that is the fix.** Identity is the release name,
    /// compared across platforms so one record on both Bandcamp and Mirlo is one alert rather
    /// than two — but *within* an artist, so a second, different record is always new.
    ///
    /// There used to be a second layer on top of this in `checkAllArtists`, asking whether the
    /// display list already held any release by the same artist. Because this function has
    /// already recorded the release as known by the time that check ran, a genuinely-new second
    /// record was dropped from the list and the notification while being marked as seen — so it
    /// could never be detected again. Extracted here, `inout` over the state, so the rule can be
    /// tested directly rather than only through a network call.
    nonisolated static func selectUnseen(
        _ results: [ReleaseCheckResult],
        artistName: String,
        state: inout ReleaseCheckState
    ) -> [NewRelease] {
        var fresh: [NewRelease] = []

        for result in results {
            if state.isKnownReleaseByName(result.releaseName, for: artistName) { continue }

            state.addKnownRelease(
                KnownRelease(releaseName: result.releaseName, releaseDate: result.releaseDate, platform: result.platform),
                for: artistName
            )

            fresh.append(NewRelease(
                artistName: artistName,
                releaseName: result.releaseName,
                releaseDate: result.releaseDate,
                releaseUrl: result.releaseUrl,
                platform: result.platform,
                platforms: result.platforms,
                status: result.status,
                offerSummary: result.offerSummary
            ))
        }

        return fresh
    }

    // MARK: - Notifications

    /// What a release notification actually says.
    ///
    /// The old body was `"X" is out now on Bandcamp!` — one platform, no formats, no price, at
    /// the exact moment someone is deciding whether and where to buy. With the catalog behind
    /// the API there is real information to offer instead, so this builds up from whatever the
    /// server actually knew rather than asserting a fixed shape:
    ///
    ///   "Infinite Normal" — out now on Bandcamp and Mirlo · from $8 · ≈$6.80 to artist
    ///   "Next Year" — announced, 1 September
    ///
    /// Nothing is invented: an empty `offerSummary` (no price read yet) simply omits that
    /// clause rather than printing a placeholder.
    /// `nonisolated` because it is a pure function of its argument — it touches no manager
    /// state, so there is no reason to make callers (including tests) hop to the main actor.
    nonisolated static func notificationBody(for release: NewRelease) -> String {
        var parts: [String] = []

        let where_ = formatPlatformList(release.platforms)
        if release.isUpcoming {
            let formatter = DateFormatter()
            formatter.dateFormat = "d MMMM"
            let date = formatter.string(from: release.releaseDate)
            parts.append(where_.isEmpty ? "announced for \(date)" : "announced for \(date) on \(where_)")
        } else {
            parts.append(where_.isEmpty ? "out now" : "out now on \(where_)")
        }

        if !release.offerSummary.isEmpty {
            parts.append(release.offerSummary)
        }

        return "\"\(release.releaseName)\" — " + parts.joined(separator: " · ")
    }

    /// "Bandcamp", "Bandcamp and Mirlo", "Bandcamp, Mirlo and 2 more" — a notification body has
    /// very little room, so a long list is summarized rather than truncated mid-name.
    nonisolated private static func formatPlatformList(_ platforms: [String]) -> String {
        // platformCatalog carries the proper display name ("Jam.coop", "Ko-fi"), which
        // `.capitalized` would mangle. An unknown id falls back rather than being dropped.
        let names = platforms.map { platformCatalog[$0]?.name ?? $0.capitalized }
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        case 2: return "\(names[0]) and \(names[1])"
        default: return "\(names[0]), \(names[1]) and \(names.count - 2) more"
        }
    }

    private func sendNotifications(for releases: [NewRelease]) async {
        // Check authorization status first
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized else { return }

        // Send individual notification for each release
        for release in releases {

            let content = UNMutableNotificationContent()
            content.title = release.isUpcoming
                ? "\(release.artistName) — coming soon"
                : "New Release from \(release.artistName)"
            content.body = Self.notificationBody(for: release)
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

    // MARK: - Dismissed Release Sync (iCloud KVS)

    private func loadDismissedIds() -> Set<UUID> {
        guard let strings = iCloudStore.array(forKey: dismissedIdsKey) as? [String] else {
            return []
        }
        return Set(strings.compactMap { UUID(uuidString: $0) })
    }

    private func saveDismissedId(_ id: UUID) {
        var ids = (iCloudStore.array(forKey: dismissedIdsKey) as? [String]) ?? []
        let idString = id.uuidString
        if !ids.contains(idString) {
            ids.append(idString)
            // Cap at 200 entries to avoid unbounded growth
            if ids.count > 200 {
                ids = Array(ids.suffix(200))
            }
            iCloudStore.set(ids, forKey: dismissedIdsKey)
            iCloudStore.synchronize()
        }
    }

    private func setupDismissedIdSync() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(dismissedIdsDidUpdate),
            name: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: iCloudStore
        )
        iCloudStore.synchronize()
    }

    @objc private func dismissedIdsDidUpdate(_ notification: Notification) {
        Task { @MainActor in
            let dismissedIds = loadDismissedIds()
            newReleases.removeAll { dismissedIds.contains($0.id) }
            checkState.newReleases.removeAll { dismissedIds.contains($0.id) }
            saveState()
        }
    }
}
