import SwiftUI
import Combine

@main
struct UnstreamMenubarApp: App {
    @StateObject private var appState = AppState()
    @StateObject private var mediaObserver = MediaObserver()
    @StateObject private var licenseManager = LicenseManager()
    @StateObject private var supportListManager = SupportListManager()

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
