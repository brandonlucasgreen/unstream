import SwiftUI
import Combine
import AppKit
import ServiceManagement
import UserNotifications

// MARK: - Shared State Container

/// Holds all the shared state managers so they can be accessed by both AppDelegate and SwiftUI views
@MainActor
class AppStateContainer: ObservableObject {
    static let shared = AppStateContainer()

    let appState = AppState()
    let mediaObserver = MediaObserver()
    let licenseManager: LicenseManager
    let supportListManager: SupportListManager
    let releaseAlertManager: ReleaseAlertManager
    let scrobbleManager = ScrobbleManager.shared

    private var cancellables = Set<AnyCancellable>()

    private init() {
        let license = LicenseManager()
        let supportList = SupportListManager()
        let releaseAlert = ReleaseAlertManager(supportListManager: supportList, licenseManager: license)

        self.licenseManager = license
        self.supportListManager = supportList
        self.releaseAlertManager = releaseAlert

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
    }
}

// MARK: - App Delegate (Pure AppKit - no SwiftUI App)

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    static var shared: AppDelegate?

    // Static to ensure only ONE status item ever exists
    private static var statusItem: NSStatusItem?
    private static var hasCreatedStatusItem = false

    private var popover: NSPopover!
    private var eventMonitor: Any?
    private var settingsWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self

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

        // Create the SwiftUI content view with all the environment objects
        let container = AppStateContainer.shared
        let contentView = PopoverView()
            .environmentObject(container.appState)
            .environmentObject(container.licenseManager)
            .environmentObject(container.supportListManager)
            .environmentObject(container.releaseAlertManager)

        popover.contentViewController = NSHostingController(rootView: contentView)

        // Set up event monitor to close popover when clicking outside
        eventMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            if let popover = self?.popover, popover.isShown {
                popover.performClose(nil)
            }
        }

        // Initialize welcome launcher
        _ = WelcomeWindowLauncher.shared
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
        }
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

    // Handle notification when app is in foreground
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // Notification click - open URL directly, don't activate app
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Open the URL
        if let releaseUrl = response.notification.request.content.userInfo["releaseUrl"] as? String,
           let url = URL(string: releaseUrl) {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
    }

    // Open settings window
    func openSettings() {
        if settingsWindow == nil {
            let container = AppStateContainer.shared
            let settingsView = SettingsView(
                licenseManager: container.licenseManager,
                releaseAlertManager: container.releaseAlertManager
            )

            let hostingController = NSHostingController(rootView: settingsView)

            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 320, height: 400),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            window.title = "Unstream Settings"
            window.contentViewController = hostingController
            window.center()
            window.isReleasedWhenClosed = false

            settingsWindow = window
        }

        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // Prevent app reopen from creating duplicates
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        return false
    }
}

// MARK: - Welcome Window Launcher

class WelcomeWindowLauncher {
    static let shared = WelcomeWindowLauncher()
    private var window: NSWindow?
    private var hasAttemptedShow = false
    private var observers: [Any] = []

    init() {
        guard !UserDefaults.standard.bool(forKey: "hasLaunchedBefore") else { return }

        let timer = Timer(timeInterval: 1.0, repeats: false) { [weak self] _ in
            self?.showWelcomeWindow()
        }
        RunLoop.main.add(timer, forMode: .common)

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.showWelcomeWindow()
        }

        let observer = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self?.showWelcomeWindow()
            }
        }
        observers.append(observer)
    }

    func showWelcomeWindow() {
        guard !UserDefaults.standard.bool(forKey: "hasLaunchedBefore") else { return }
        guard !hasAttemptedShow else { return }
        hasAttemptedShow = true

        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()

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

// MARK: - SwiftUI App (minimal - settings handled by AppDelegate)

@main
struct UnstreamMenubarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // Empty Settings scene - actual settings handled by AppDelegate.openSettings()
        Settings {
            EmptyView()
        }
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
