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
                        // Empty state
                        VStack(spacing: 16) {
                            Image(systemName: "music.note.house")
                                .font(.system(size: 48))
                                .foregroundColor(.secondary.opacity(0.5))

                            Text("Search for an artist to find them\non ethical music platforms")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                                .multilineTextAlignment(.center)

                            if isBandcampFriday() {
                                HStack(spacing: 6) {
                                    Image(systemName: "sparkles")
                                        .foregroundColor(Color(hex: "#1DA0C3") ?? .blue)
                                    Text("It's Bandcamp Friday!")
                                        .font(.subheadline)
                                        .fontWeight(.medium)
                                        .foregroundColor(Color(hex: "#1DA0C3") ?? .blue)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background((Color(hex: "#1DA0C3") ?? .blue).opacity(0.1))
                                .cornerRadius(8)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 60)
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
