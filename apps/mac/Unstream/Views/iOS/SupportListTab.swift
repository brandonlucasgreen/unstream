#if os(iOS)
import SwiftUI

struct SupportListTab: View {
    @EnvironmentObject var supportListManager: SupportListManager
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager
    @EnvironmentObject var appState: AppState
    @ObservedObject private var auth = AuthService.shared

    var body: some View {
        NavigationStack {
            ScrollView {
                // Signed in, the account's list is the saved list — the one the heart writes to
                // (see SavedArtistsRouter). Signed out, the list saved on this device.
                if auth.isSignedIn {
                    SyncedArtistsView(onSearchArtist: { name in
                        appState.searchQuery = name
                        appState.clearResults()
                        appState.selectedTab = 0
                        Task { await appState.performSearch() }
                    })
                    .padding()
                } else {
                    SupportListView(
                        supportListManager: supportListManager,
                        releaseAlertManager: releaseAlertManager
                    )
                    .padding()
                }
            }
            .navigationTitle("Saved Artists")
        }
    }
}
#endif
