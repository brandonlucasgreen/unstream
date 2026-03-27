#if os(iOS)
import SwiftUI

struct iOSContentView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var supportListManager: SupportListManager
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager

    var body: some View {
        TabView {
            SearchTab()
                .tabItem {
                    Label("Search", systemImage: "magnifyingglass")
                }

            SupportListTab()
                .tabItem {
                    Label("Saved", systemImage: "heart.fill")
                }

            ReleasesTab()
                .tabItem {
                    Label("Releases", systemImage: "sparkles")
                }

            iOSSettingsTab()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
    }
}
#endif
