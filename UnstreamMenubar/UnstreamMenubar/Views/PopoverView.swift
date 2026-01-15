import SwiftUI

enum PopoverTab {
    case search
    case supportList
}

struct PopoverView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var licenseManager: LicenseManager
    @EnvironmentObject var supportListManager: SupportListManager
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager

    @State private var selectedTab: PopoverTab = .search

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar
            HStack(spacing: 0) {
                TabButton(
                    title: "Search",
                    icon: "magnifyingglass",
                    isSelected: selectedTab == .search
                ) {
                    selectedTab = .search
                }

                TabButton(
                    title: "Saved Artists",
                    icon: "heart.fill",
                    isSelected: selectedTab == .supportList,
                    badge: licenseManager.isPro ? supportListManager.entries.count : nil
                ) {
                    selectedTab = .supportList
                }
            }
            .padding(.horizontal)
            .padding(.top, 8)

            // Search bar (only visible on search tab)
            if selectedTab == .search {
                SearchBarView()
                    .padding()
            }

            Divider()

            // Content area
            ScrollView {
                VStack(spacing: 12) {
                    if selectedTab == .supportList {
                        if licenseManager.isPro {
                            SupportListView(
                                supportListManager: supportListManager,
                                releaseAlertManager: releaseAlertManager
                            )
                        } else {
                            ProUpgradeView()
                        }
                    } else {
                        // Search tab content
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
                }
                .padding()
            }
            .frame(maxHeight: 350)

            Divider()

            // Footer
            HStack {
                Spacer()

                Menu {
                    Button(action: {
                        AppDelegate.shared?.openSettings()
                    }) {
                        Label("Settings", systemImage: "gearshape")
                    }

                    Divider()

                    Link(destination: URL(string: "https://unstream.featurebase.app/roadmap")!) {
                        Label("Roadmap", systemImage: "map")
                    }

                    Link(destination: URL(string: "https://unstream.featurebase.app")!) {
                        Label("Share Feedback", systemImage: "bubble.left")
                    }

                    Link(destination: URL(string: "mailto:support@unstream.stream")!) {
                        Label("Support", systemImage: "envelope")
                    }

                    Divider()

                    Button(action: {
                        NSApplication.shared.terminate(nil)
                    }) {
                        Label("Quit", systemImage: "power")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 16))
                        .foregroundColor(.secondary)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .frame(width: 320)
    }
}

struct TabButton: View {
    let title: String
    let icon: String
    let isSelected: Bool
    var badge: Int? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                Text(title)
                    .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                if let badge = badge, badge > 0 {
                    Text("\(badge)")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(isSelected ? Color.accentColor.opacity(0.1) : Color.clear)
            .foregroundColor(isSelected ? .accentColor : .secondary)
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
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

private struct PopoverViewPreviewContainer: View {
    @StateObject private var supportList = SupportListManager()
    @StateObject private var license = LicenseManager()
    @StateObject private var appState = AppState()

    var body: some View {
        PopoverView()
            .environmentObject(appState)
            .environmentObject(license)
            .environmentObject(supportList)
            .environmentObject(ReleaseAlertManager(supportListManager: supportList, licenseManager: license))
    }
}

#Preview {
    PopoverViewPreviewContainer()
}
