#if os(iOS)
import SwiftUI

struct SupportListTab: View {
    @EnvironmentObject var supportListManager: SupportListManager
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager

    var body: some View {
        NavigationStack {
            ScrollView {
                SupportListView(
                    supportListManager: supportListManager,
                    releaseAlertManager: releaseAlertManager
                )
                .padding()
            }
            .navigationTitle("Saved Artists")
        }
    }
}
#endif
