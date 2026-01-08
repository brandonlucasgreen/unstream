import SwiftUI
import Combine
import AppKit

// Welcome window launcher - shows ONLY on first launch, with multiple fallback mechanisms
// to ensure 100% reliability
class WelcomeWindowLauncher {
    static let shared = WelcomeWindowLauncher()
    private var window: NSWindow?
    private var hasAttemptedShow = false
    private var observers: [Any] = []

    init() {
        // Only set up triggers on first launch
        guard !UserDefaults.standard.bool(forKey: "hasLaunchedBefore") else { return }

        // Method 1: Timer on main run loop with .common mode (works during UI events)
        let timer = Timer(timeInterval: 1.0, repeats: false) { [weak self] _ in
            self?.showWelcomeWindow()
        }
        RunLoop.main.add(timer, forMode: .common)

        // Method 2: DispatchQueue as backup
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.showWelcomeWindow()
        }

        // Method 3: Listen for app activation as another fallback
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
        // Only show once, only on first launch
        guard !UserDefaults.standard.bool(forKey: "hasLaunchedBefore") else { return }
        guard !hasAttemptedShow else { return }
        hasAttemptedShow = true

        // Clean up observers since we're showing now
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

        // Force the app and window to the front
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.requestUserAttention(.criticalRequest)
    }

    func dismiss() {
        // Mark as launched so it never shows again
        UserDefaults.standard.set(true, forKey: "hasLaunchedBefore")
        window?.close()
        window = nil
    }
}

@main
struct UnstreamMenubarApp: App {
    @StateObject private var appState = AppState()
    @StateObject private var mediaObserver = MediaObserver()
    @StateObject private var licenseManager = LicenseManager()
    @StateObject private var supportListManager = SupportListManager()

    // Initialize welcome launcher - must keep reference to prevent deallocation
    private let welcomeLauncher = WelcomeWindowLauncher.shared

    var body: some Scene {
        MenuBarExtra {
            PopoverView()
                .environmentObject(appState)
                .environmentObject(licenseManager)
                .environmentObject(supportListManager)
                .onReceive(mediaObserver.$currentTrack) { nowPlaying in
                    Task {
                        await appState.updateNowPlaying(nowPlaying)
                    }
                }
        } label: {
            Image("MenuBarIcon")
        }
        .menuBarExtraStyle(.window)

        // Standalone Settings window
        Window("Unstream Settings", id: "settings") {
            SettingsView(licenseManager: licenseManager)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
    }
}

struct WelcomeContentView: View {
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            // Use the high-res app icon instead of the small menu bar icon
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
