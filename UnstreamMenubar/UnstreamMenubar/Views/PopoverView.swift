import SwiftUI

struct PopoverView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 0) {
            // Search bar (always visible)
            SearchBarView()
                .padding()

            Divider()

            // Content area
            ScrollView {
                VStack(spacing: 12) {
                    switch appState.displayMode {
                    case .searchResults:
                        if appState.isSearching {
                            LoadingView()
                        } else if let error = appState.searchError {
                            ErrorView(message: error)
                        } else if appState.searchResults.isEmpty && !appState.searchQuery.isEmpty {
                            Text("No results found for \"\(appState.searchQuery)\"")
                                .font(.caption)
                                .foregroundColor(.secondary)
                                .padding(.vertical, 20)
                        } else {
                            ResultsView(
                                title: "Search Results",
                                results: appState.searchResults
                            )
                        }

                    case .nowPlaying:
                        if let nowPlaying = appState.nowPlaying {
                            NowPlayingView(nowPlaying: nowPlaying)
                            if appState.isLoadingNowPlaying {
                                LoadingView()
                            } else if !appState.nowPlayingResults.isEmpty {
                                ResultsView(
                                    title: nil,
                                    results: appState.nowPlayingResults
                                )
                            } else {
                                Text("Searching for platforms...")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    .padding(.vertical, 8)
                            }
                        }

                    case .empty:
                        EmptyStateView()
                    }
                }
                .padding()
            }
            .frame(maxHeight: 350)

            Divider()

            // Footer
            HStack {
                Button(action: { openWindow(id: "settings") }) {
                    Label("Settings", systemImage: "gear")
                        .font(.caption)
                }
                .buttonStyle(.plain)

                Spacer()

                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .font(.caption)
                .buttonStyle(.plain)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .frame(width: 320)
    }
}

struct LoadingView: View {
    var body: some View {
        VStack(spacing: 8) {
            ProgressView()
                .scaleEffect(0.8)
            Text("Searching...")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }
}

struct ErrorView: View {
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title2)
                .foregroundColor(.orange)
            Text(message)
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }
}

#Preview {
    PopoverView()
        .environmentObject(AppState())
}
