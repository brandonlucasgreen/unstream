import SwiftUI
import Combine
import UserNotifications

#if os(macOS)
import AppKit
import ServiceManagement
#endif

#if os(iOS)
import BackgroundTasks
#endif

// MARK: - Shared State Container

/// Holds all the shared state managers so they can be accessed by both platforms
@MainActor
class AppStateContainer: ObservableObject {
    static let shared = AppStateContainer()

    let appState = AppState()
    let supportListManager: SupportListManager
    let releaseAlertManager: ReleaseAlertManager
    #if os(iOS)
    let indieArtistDirectory = IndieArtistDirectoryService()
    #endif

    #if os(macOS)
    let mediaObserver = MediaObserver()
    let scrobbleManager = ScrobbleManager.shared
    let nowPlayingNotificationManager = NowPlayingNotificationManager()
    #endif

    private var cancellables = Set<AnyCancellable>()

    private init() {
        let supportList = SupportListManager()
        let releaseAlert = ReleaseAlertManager(supportListManager: supportList)

        self.supportListManager = supportList
        self.releaseAlertManager = releaseAlert

        #if os(macOS)
        // Wire artist detection notifications
        appState.onArtistResultsReady = { [weak self] artist, results in
            await self?.nowPlayingNotificationManager.handleArtistDetected(artist, results: results)
        }

        // Set up media observer to update app state
        mediaObserver.$currentTrack
            .sink { [weak self] nowPlaying in
                guard let self = self else { return }
                Task {
                    await self.appState.updateNowPlaying(nowPlaying)
                }
                self.scrobbleManager.trackChanged(to: nowPlaying)
            }
            .store(in: &cancellables)
        #endif
    }

    /// Check for an artist the share extension queued for saving (iOS).
    func checkPendingSave() {
        guard let defaults = UserDefaults(suiteName: "group.lol.bgreen.unstream"),
              let data = defaults.data(forKey: "pendingSaveArtist") else { return }

        defaults.removeObject(forKey: "pendingSaveArtist")
        defaults.synchronize()

        struct PendingPlatform: Decodable { let sourceId: String; let url: String }
        struct PendingArtist: Decodable { let name: String; let imageUrl: String?; let platforms: [PendingPlatform] }

        guard let pending = try? JSONDecoder().decode(PendingArtist.self, from: data) else { return }
        supportListManager.addEntryFromExtension(
            name: pending.name,
            imageUrl: pending.imageUrl,
            platforms: pending.platforms.map { ($0.sourceId, $0.url) }
        )
    }

    /// Check for a pending search from the share extension (iOS)
    func checkPendingSearch() {
        guard let sharedDefaults = UserDefaults(suiteName: "group.lol.bgreen.unstream"),
              let pendingQuery = sharedDefaults.string(forKey: "pendingSearch"),
              !pendingQuery.isEmpty else { return }

        // Ignore stale pending searches (older than 5 minutes)
        let timestamp = sharedDefaults.double(forKey: "pendingSearchTimestamp")
        if timestamp > 0 {
            let age = Date().timeIntervalSince1970 - timestamp
            guard age < 300 else {
                sharedDefaults.removeObject(forKey: "pendingSearch")
                sharedDefaults.removeObject(forKey: "pendingSearchTimestamp")
                return
            }
        }

        // Clear the pending search
        sharedDefaults.removeObject(forKey: "pendingSearch")
        sharedDefaults.removeObject(forKey: "pendingSearchTimestamp")

        // Switch to the Search tab and perform the search
        appState.selectedTab = 0
        appState.searchQuery = pendingQuery
        Task {
            await appState.performSearch()
        }
    }
}

// MARK: - SwiftUI App

@main
struct UnstreamApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    #elseif os(iOS)
    @UIApplicationDelegateAdaptor(iOSAppDelegate.self) var appDelegate
    #endif

    @ObservedObject private var container = AppStateContainer.shared
    #if os(iOS)
    @Environment(\.scenePhase) private var scenePhase
    #endif

    var body: some Scene {
        #if os(macOS)
        // The popover is driven by AppDelegate (NSStatusItem), but Settings is a real
        // SwiftUI Settings scene: that's what gives us the standard settings window,
        // its frame persistence, and a working "Unstream ▸ Settings… ⌘," menu item.
        Settings {
            SettingsView(releaseAlertManager: container.releaseAlertManager)
        }
        #else
        // iOS: Standard windowed app
        WindowGroup {
            iOSContentView()
                .environmentObject(container.appState)
                .environmentObject(container.supportListManager)
                .environmentObject(container.releaseAlertManager)
                .environmentObject(container.indieArtistDirectory)
                .onOpenURL { url in
                    handleNonAuthIncomingURL(url)
                }
                .onAppear {
                    container.checkPendingSearch()
                    container.checkPendingSave()
                }
                .onChange(of: scenePhase) { newPhase in
                    if newPhase == .active {
                        container.checkPendingSearch()
                        container.checkPendingSave()
                        // Refresh sync on foreground
                        if AuthService.shared.isSignedIn {
                            Task { await SavedArtistsSync.shared.pull() }
                        }
                    }
                }
        }
        #endif
    }

    #if os(iOS)
    private func handleNonAuthIncomingURL(_ url: URL) {
        // Search deeplink: unstream://search?q=...
        guard url.scheme == "unstream",
              url.host == "search",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let query = components.queryItems?.first(where: { $0.name == "q" })?.value,
              !query.isEmpty else { return }

        container.appState.selectedTab = 0
        container.appState.searchQuery = query
        Task {
            await container.appState.performSearch()
        }
    }
    #endif
}

// MARK: - iOS App Delegate

#if os(iOS)

class iOSAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let releaseCheckTaskId = "lol.bgreen.Unstream.releaseCheck"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        registerBackgroundTasks()
        return true
    }

    // MARK: - Background Release Checks

    private func registerBackgroundTasks() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.releaseCheckTaskId,
            using: nil
        ) { task in
            guard let appRefreshTask = task as? BGAppRefreshTask else { return }
            self.handleReleaseCheck(task: appRefreshTask)
        }
        scheduleReleaseCheck()
    }

    private func handleReleaseCheck(task: BGAppRefreshTask) {
        let checkTask = Task {
            await AppStateContainer.shared.releaseAlertManager.checkNow()
        }

        task.expirationHandler = {
            checkTask.cancel()
        }

        Task {
            _ = await checkTask.value
            task.setTaskCompleted(success: true)
            self.scheduleReleaseCheck()
        }
    }

    func scheduleReleaseCheck() {
        let request = BGAppRefreshTaskRequest(identifier: Self.releaseCheckTaskId)
        // Check no sooner than 6 hours from now
        request.earliestBeginDate = Date(timeIntervalSinceNow: 6 * 60 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("[BGTask] Failed to schedule release check: \(error)")
        }
    }

    // Show notifications even when the app is in the foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // Handle notification taps — open the release URL
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let releaseUrl = response.notification.request.content.userInfo["releaseUrl"] as? String,
           let url = URL(string: releaseUrl) {
            UIApplication.shared.open(url)
        }
        completionHandler()
    }
}

#endif

// MARK: - macOS App Delegate

#if os(macOS)

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    static var shared: AppDelegate?

    // Static to ensure only ONE status item ever exists
    private static var statusItem: NSStatusItem?
    private static var hasCreatedStatusItem = false

    private var popover: NSPopover!

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self

        // Hide from dock — menu bar only (replaces LSUIElement in Info.plist for multiplatform compat)
        NSApp.setActivationPolicy(.accessory)

        // Set notification delegate so we can handle clicks
        UNUserNotificationCenter.current().delegate = self

        // Create the status item ONLY ONCE ever (static check)
        if !AppDelegate.hasCreatedStatusItem {
            AppDelegate.hasCreatedStatusItem = true
            AppDelegate.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

            if let button = AppDelegate.statusItem?.button {
                button.image = NSImage(named: "MenuBarIcon")
                button.action = #selector(togglePopover)
                button.target = self
            }
        }

        // Create the popover
        popover = NSPopover()
        popover.contentSize = NSSize(width: 320, height: 480)
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self

        // Create the SwiftUI content view with all the environment objects
        let container = AppStateContainer.shared
        let contentView = PopoverView()
            .environmentObject(container.appState)
            .environmentObject(container.supportListManager)
            .environmentObject(container.releaseAlertManager)

        popover.contentViewController = NSHostingController(rootView: contentView)

        // No click-outside monitor: popover.behavior = .transient already dismisses on
        // outside clicks. A global monitor only sees events routed to *other* apps, so it
        // added nothing and risked closing the popover under sheets and share pickers.

        // Auth callbacks are handled by ASWebAuthenticationSession in AuthService;
        // no NSAppleEventManager handler needed.

        // Initialize welcome launcher
        _ = WelcomeWindowLauncher.shared

        // Initialize global hotkey manager (starts listening if enabled)
        _ = GlobalHotkeyManager.shared
    }

    @objc func togglePopover() {
        guard let button = AppDelegate.statusItem?.button else { return }

        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    func closePopover() {
        if popover.isShown {
            popover.performClose(nil)
        }
    }

    // Handle notification when app is in foreground
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // Notification click — open artist page or release URL in browser
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let urlString = (userInfo["artistUrl"] as? String) ?? (userInfo["releaseUrl"] as? String)
        if let urlString, let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
    }

    /// Opens the SwiftUI `Settings` scene.
    ///
    /// `SettingsLink` is macOS 14+ and we still support 13, so instead of hardcoding a
    /// private selector (`showSettingsWindow:`) we perform the real "Settings… ⌘," item
    /// that SwiftUI puts in the app menu. Its action is a SwiftUI-internal callback, so
    /// sending it via the item keeps working regardless of what Apple renames.
    func openSettings() {
        // Close the popover first so it doesn't obscure settings
        if popover.isShown {
            popover.performClose(nil)
        }

        NSApp.activate(ignoringOtherApps: true)

        guard let appMenu = NSApp.mainMenu?.items.first?.submenu,
              let item = appMenu.items.first(where: { $0.keyEquivalent == "," && $0.action != nil }),
              let action = item.action else {
            assertionFailure("No Settings item in the app menu — did the Settings scene go away?")
            return
        }
        NSApp.sendAction(action, to: item.target, from: item)
    }

    // Prevent app reopen from creating duplicates
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        return false
    }
}

// MARK: - Popover close notification

extension Notification.Name {
    static let popoverDidClose = Notification.Name("unstreamPopoverDidClose")
}

extension AppDelegate: NSPopoverDelegate {
    func popoverDidClose(_ notification: Notification) {
        AuthService.shared.cancelPendingAuth()
        NotificationCenter.default.post(name: .popoverDidClose, object: nil)
    }
}

// MARK: - Welcome Window Launcher

class WelcomeWindowLauncher {
    static let shared = WelcomeWindowLauncher()
    private var window: NSWindow?
    private var hasAttemptedShow = false

    init() {
        guard !UserDefaults.standard.bool(forKey: "hasLaunchedBefore") else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.showWelcomeWindow()
        }
    }

    func showWelcomeWindow() {
        guard !UserDefaults.standard.bool(forKey: "hasLaunchedBefore") else { return }
        guard !hasAttemptedShow else { return }
        hasAttemptedShow = true

        let welcomeView = WelcomeContentView {
            self.dismiss()
        }

        let hostingView = NSHostingView(rootView: welcomeView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 300),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Welcome to Unstream"
        window.contentView = hostingView
        window.center()
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        self.window = window

        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.requestUserAttention(.criticalRequest)
    }

    func dismiss() {
        UserDefaults.standard.set(true, forKey: "hasLaunchedBefore")

        if !UserDefaults.standard.bool(forKey: "hasSetLaunchAtLoginDefault") {
            UserDefaults.standard.set(true, forKey: "hasSetLaunchAtLoginDefault")
            do {
                try SMAppService.mainApp.register()
            } catch {
                print("[WelcomeLauncher] Failed to enable launch at login: \(error)")
            }
        }

        window?.close()
        window = nil
    }
}

// MARK: - Welcome Content View

struct WelcomeContentView: View {
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 64, height: 64)

            Text("Unstream is running!")
                .font(.title2)
                .fontWeight(.semibold)

            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "menubar.arrow.up.rectangle")
                        .foregroundColor(.accentColor)
                        .frame(width: 20)
                    Text("Click the icon in your menu bar to search for artists.")
                        .font(.body)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "music.note")
                        .foregroundColor(.accentColor)
                        .frame(width: 20)
                    Text("Play music to see where the artist is available.")
                        .font(.body)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal)

            Button("Got it!") {
                onDismiss()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(30)
        .frame(width: 420, height: 300)
    }
}

#endif
