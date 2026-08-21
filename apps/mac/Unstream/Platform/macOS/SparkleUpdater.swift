import AppKit
import Combine
import Sparkle
import UserNotifications

/// Owns Sparkle's updater for the Mac app.
///
/// The Mac app ships as a direct GitHub release rather than through the Mac App Store, so
/// it is responsible for updating itself. This replaces the hand-rolled `UpdateChecker`,
/// which could only *tell* people an update existed and then sent them to a browser to
/// download and drag it over their own install. Sparkle downloads, verifies the EdDSA
/// signature and the Developer ID code signature, installs, and relaunches.
///
/// Two things make this app an awkward fit for Sparkle's defaults, and both are handled here:
///
/// 1. **It's sandboxed.** Sparkle reaches its installer through an XPC service inside
///    `Sparkle.framework`, which needs `SUEnableInstallerLauncherService` in Info.plist and
///    the two `-spks` / `-spki` mach-lookup exceptions in the entitlements. Change one, change
///    all three, or updates fail at the install step *after* downloading successfully.
/// 2. **It's a menu bar accessory.** With no window and no Dock icon, Sparkle's normal
///    "show the update alert" has nowhere polite to go. So this implements Sparkle's gentle
///    reminders: a scheduled update brings the app into the Dock with a badge and (only if
///    notifications are already authorized) posts a notification, instead of throwing a
///    window in front of whatever the person was doing.
@MainActor
final class SparkleUpdater: NSObject, ObservableObject {
    static let shared = SparkleUpdater()

    /// Identifies the update notification so `AppDelegate` can tell a click on it apart from
    /// a click on an artist or release notification, and so it can be withdrawn again.
    static let notificationIdentifier = "unstream-sparkle-update"

    /// Sparkle disables its own menu item while a check is in flight; mirrored for SwiftUI.
    @Published private(set) var canCheckForUpdates = false

    /// Mirrors of Sparkle's settings. Sparkle is the store of record for both (they live in
    /// UserDefaults under `SUEnableAutomaticChecks` / `SUAutomaticallyUpdate`); these exist so
    /// SwiftUI can bind a Toggle, and write straight back through on change.
    @Published var automaticallyChecksForUpdates = false {
        didSet {
            guard automaticallyChecksForUpdates != updater.automaticallyChecksForUpdates else { return }
            updater.automaticallyChecksForUpdates = automaticallyChecksForUpdates
        }
    }

    @Published var automaticallyDownloadsUpdates = false {
        didSet {
            guard automaticallyDownloadsUpdates != updater.automaticallyDownloadsUpdates else { return }
            updater.automaticallyDownloadsUpdates = automaticallyDownloadsUpdates
        }
    }

    /// Assigned in `init` after `super.init()`, because Sparkle wants `self` as both delegates.
    private var controller: SPUStandardUpdaterController!

    var updater: SPUUpdater { controller.updater }

    private override init() {
        super.init()

        // Started explicitly below rather than by the initializer, so the legacy setting is
        // migrated before Sparkle can act on the value it's migrating away from.
        controller = SPUStandardUpdaterController(
            startingUpdater: false,
            updaterDelegate: self,
            userDriverDelegate: self
        )

        migrateLegacyAutomaticCheckSetting()

        automaticallyChecksForUpdates = updater.automaticallyChecksForUpdates
        automaticallyDownloadsUpdates = updater.automaticallyDownloadsUpdates

        updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheckForUpdates)

        controller.startUpdater()
    }

    /// A user-initiated check. Sparkle always shows its own UI for these — including
    /// "you're up to date", which the old Settings pane had to render itself.
    func checkForUpdates() {
        NSApp.activate(ignoringOtherApps: true)
        updater.checkForUpdates()
    }

    /// Carries the pre-Sparkle "Check for updates automatically" toggle over exactly once.
    ///
    /// The old key defaulted to on when absent, so only an explicit `false` is worth moving:
    /// somebody who deliberately turned update checks off should not find them back on after
    /// installing the version that adopted Sparkle.
    private func migrateLegacyAutomaticCheckSetting() {
        let legacyKey = "checkForUpdatesAutomatically"
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: legacyKey) != nil else { return }

        if !defaults.bool(forKey: legacyKey) {
            updater.automaticallyChecksForUpdates = false
        }
        defaults.removeObject(forKey: legacyKey)
    }

    /// Called by `AppDelegate` when a notification is clicked. Returns whether it was ours.
    func handleNotificationClick(identifier: String) -> Bool {
        guard identifier == Self.notificationIdentifier else { return false }
        // Brings the update alert Sparkle already prepared back into focus. If the app was
        // relaunched by the click, this starts a fresh check instead.
        checkForUpdates()
        return true
    }
}

// MARK: - Gentle reminders

// Sparkle's delegates are Objective-C protocols with no actor annotations, so the methods are
// `nonisolated` and re-enter the main actor with `assumeIsolated`. Sparkle already calls them
// on the main thread; asserting that is cheaper and keeps ordering, where a `Task` hop would
// let the dock badge land after the alert it belongs to. Same shape as `AppDelegate`'s
// `UNUserNotificationCenterDelegate` methods.
extension SparkleUpdater: SPUStandardUserDriverDelegate {
    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }

    nonisolated func standardUserDriverWillHandleShowingUpdate(
        _ handleShowingUpdate: Bool,
        forUpdate update: SUAppcastItem,
        state: SPUUserUpdateState
    ) {
        MainActor.assumeIsolated {
            // Sparkle is about to show an alert, so the app needs a Dock icon and a place in
            // the app switcher for the duration — otherwise the alert belongs to an app the
            // person can't see or command-tab back to. Undone in willFinishUpdateSession.
            NSApp.setActivationPolicy(.regular)

            guard !state.userInitiated else { return }

            NSApp.dockTile.badgeLabel = "1"
            let version = update.displayVersionString
            Task { await self.postUpdateNotification(version: version) }
        }
    }

    nonisolated func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) {
        MainActor.assumeIsolated {
            NSApp.dockTile.badgeLabel = ""
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: [Self.notificationIdentifier]
            )
        }
    }

    nonisolated func standardUserDriverWillFinishUpdateSession() {
        MainActor.assumeIsolated {
            NSApp.dockTile.badgeLabel = ""
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

extension SparkleUpdater {
    /// Deliberately does *not* ask for notification permission. Prompting somebody for
    /// notifications so the app can mention an update is a bad trade, and the Dock badge
    /// already carries the reminder on its own. If they've allowed notifications for
    /// now-playing or release alerts, this rides along on that.
    fileprivate func postUpdateNotification(version: String) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else { return }

        let content = UNMutableNotificationContent()
        content.title = "Unstream \(version) is available"
        content.body = "You're on \(Bundle.main.appVersion). Click to install the update."

        let request = UNNotificationRequest(
            identifier: Self.notificationIdentifier,
            content: content,
            trigger: nil
        )

        do {
            try await center.add(request)
        } catch {
            NSLog("[Sparkle] Failed to post update notification: \(error)")
        }
    }
}

// MARK: - Updater delegate

extension SparkleUpdater: SPUUpdaterDelegate {
    nonisolated func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        // Sparkle surfaces real failures to the user itself; this is only so a silent
        // scheduled check that dies leaves something behind in the log.
        let code = (error as NSError).code
        guard code != SUError.noUpdateError.rawValue,
              code != SUError.installationCanceledError.rawValue else { return }
        NSLog("[Sparkle] Update check aborted: \(error.localizedDescription)")
    }
}
