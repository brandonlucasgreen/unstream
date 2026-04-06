#if os(iOS)
import SwiftUI

struct iOSContentView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var supportListManager: SupportListManager
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager

    var body: some View {
        TabView(selection: $appState.selectedTab) {
            SearchTab()
                .tabItem {
                    Label("Search", systemImage: "magnifyingglass")
                }
                .tag(0)

            SupportListTab()
                .tabItem {
                    Label("Saved", systemImage: "heart.fill")
                }
                .tag(1)

            ReleasesTab()
                .tabItem {
                    Label("Releases", systemImage: "sparkles")
                }
                .tag(2)

            iOSSettingsTab()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
                .tag(3)
        }
    }
}
#endif
