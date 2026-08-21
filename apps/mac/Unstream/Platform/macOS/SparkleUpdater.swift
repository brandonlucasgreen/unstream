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
/// 2. **It's a menu bar accessory.** It can show an update alert perfectly well: an accessory
///    app can activate and put up a key window with no Dock icon and no existing window. What
///    it can't do is let Sparkle decide *when*. Sparkle's two scheduled paths both go wrong
///    here — with immediate focus it puts a modal in front of whatever you're doing, which for
///    a launch-time check means seconds after login; without it, the docs say a dockless app's
///    alert is "presented behind other apps and windows", and an accessory app has no Dock icon
///    and no Command-Tab entry, so there is nothing to click to find it again. So this takes
///    over showing scheduled updates (Sparkle's gentle-reminder API) and announces them in the
///    popover, where the app lives, with the alert appearing only once it's asked for. While an
///    alert *is* up, the app takes a Dock icon so the window can be found again — the same thing
///    CleanShot X, Ice and Reminders MenuBar do. No Dock badge, which none of them do either.
@MainActor
final class SparkleUpdater: NSObject, ObservableObject {
    static let shared = SparkleUpdater()

    /// Identifies the update notification so `AppDelegate` can tell a click on it apart from
    /// a click on an artist or release notification, and so it can be withdrawn again.
    static let notificationIdentifier = "unstream-sparkle-update"

    /// Sparkle disables its own menu item while a check is in flight; mirrored for SwiftUI.
    @Published private(set) var canCheckForUpdates = false

    /// Set when a *scheduled* check finds an update we've taken responsibility for announcing.
    /// `PopoverView` renders it as a row; `nil` means there's nothing to say. User-initiated
    /// checks never set this — Sparkle shows those itself, immediately.
    @Published private(set) var availableVersion: String?

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

    /// Shows Sparkle's update UI. Used both for a genuine user-initiated check (Settings ▸
    /// About) and to bring up the alert for an update the popover is already announcing —
    /// Sparkle's docs name `checkForUpdates` as the way to pull an already-prepared update into
    /// focus, so there's one entry point rather than two.
    func checkForUpdates() {
        // The popover would otherwise sit on top of the alert we're about to show.
        AppDelegate.shared?.closePopover()
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
        // Shows the update Sparkle already prepared. If the app was relaunched by the click,
        // this starts a fresh check instead.
        checkForUpdates()
        return true
    }

    /// Drops the popover row and withdraws the notification, once the update is somebody
    /// else's problem — either Sparkle is showing it, or the session ended.
    private func clearReminder() {
        availableVersion = nil
        UNUserNotificationCenter.current().removeDeliveredNotifications(
            withIdentifiers: [Self.notificationIdentifier]
        )
    }
}

// MARK: - Gentle reminders

// Sparkle's delegates are Objective-C protocols with no actor annotations, so the methods are
// `nonisolated` and re-enter the main actor with `assumeIsolated`. Sparkle already calls them
// on the main thread; asserting that is cheaper than a `Task` hop and keeps ordering. Same
// shape as `AppDelegate`'s `UNUserNotificationCenterDelegate` methods.
extension SparkleUpdater: SPUStandardUserDriverDelegate {
    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }

    /// Always `false`: we announce scheduled updates ourselves. See the note on the class.
    ///
    /// `immediateFocus` is ignored deliberately. Sparkle offers it as "the app just launched, so
    /// an alert is welcome", which is true for an app you just opened and false for one that
    /// launches at login behind everything else.
    nonisolated func standardUserDriverShouldHandleShowingScheduledUpdate(
        _ update: SUAppcastItem,
        andInImmediateFocus immediateFocus: Bool
    ) -> Bool {
        false
    }

    nonisolated func standardUserDriverWillHandleShowingUpdate(
        _ handleShowingUpdate: Bool,
        forUpdate update: SUAppcastItem,
        state: SPUUserUpdateState
    ) {
        MainActor.assumeIsolated {
            // A Dock icon for the duration of the update session, then back to accessory in
            // `willFinishUpdateSession`. This is the one thing a menu bar app genuinely can't do
            // without: Sparkle's alert is a window you can walk away from, and an accessory app's
            // windows are in neither the Dock nor the app switcher, so clicking through to Safari
            // mid-decision would strand the alert behind everything with no route back to it.
            // Applied to user-initiated checks too, so "where did that window go" has one answer
            // rather than two.
            NSApp.setActivationPolicy(.regular)

            // `true` means Sparkle is showing this one itself — a user-initiated check, which
            // needs no reminder from us.
            guard !handleShowingUpdate else { return }

            let version = update.displayVersionString
            availableVersion = version
            Task { await self.postUpdateNotification(version: version) }
        }
    }

    /// Fires when the alert is first brought into focus *or* acted on — so by here the Dock
    /// icon, not this row, is what leads back to the update.
    nonisolated func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) {
        MainActor.assumeIsolated { clearReminder() }
    }

    nonisolated func standardUserDriverWillFinishUpdateSession() {
        MainActor.assumeIsolated {
            clearReminder()
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

extension SparkleUpdater {
    /// A nudge, not the channel. The popover row is what actually announces the update, so
    /// this deliberately does *not* ask for notification permission — prompting somebody for
    /// notifications in order to mention an update is a bad trade. If they've already allowed
    /// them for now-playing or release alerts, this rides along on that.
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
