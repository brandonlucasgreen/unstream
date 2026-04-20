#if os(iOS)
import SwiftUI

struct SearchTab: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var supportListManager: SupportListManager

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if appState.isSearching {
                        ProgressView("Searching...")
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 40)
                    } else if let error = appState.searchError {
                        VStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.title2)
                                .foregroundColor(.orange)
                            Text(error)
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                    } else if appState.hasSearched {
                        ResultsView(
                            title: nil,
                            results: appState.searchResults
                        )
                        .environmentObject(supportListManager)
                        .environmentObject(appState)
                    } else {
                        IndieArtistSuggestionsView()
                    }
                }
                .padding()
            }
            .navigationTitle("Unstream")
            .searchable(text: $appState.searchQuery, prompt: "Search for an artist...")
            .onSubmit(of: .search) {
                Task { await appState.performSearch() }
            }
            .onChange(of: appState.searchQuery) { newValue in
                if newValue.isEmpty {
                    appState.clearResults()
                }
            }
        }
    }
}
#endif
