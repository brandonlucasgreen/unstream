import SwiftUI

enum PopoverTab {
    case search
    case supportList
}

struct PopoverView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var supportListManager: SupportListManager
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager
    @ObservedObject private var auth = AuthService.shared
    @ObservedObject private var sync = SavedArtistsSync.shared
    @State private var selectedTab: PopoverTab = .search
    @State private var showSignIn = false
    @State private var menuPollTimer: Timer?
    @State private var menuForcePullTimer: Timer?

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
                    badge: supportListManager.entries.count > 0 ? supportListManager.entries.count : nil
                ) {
                    selectedTab = .supportList
                }
            }
            .padding(.horizontal)
            .padding(.top, 8)

            // Auth bar (shown when signed in or has synced artists)
            if auth.isSignedIn {
                Divider()
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                        .font(.system(size: 10))
                    Text(auth.userEmail ?? "Signed in")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.vertical, 4)
            }

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
                        // Synced artists from server (if signed in)
                        if auth.isSignedIn {
                            SyncedArtistsView()
                                .onAppear {
                                    startMenuPoll()
                                }
                                .onDisappear {
                                    stopMenuPoll()
                                }
                        } else {
                            // Sign-in prompt
                            VStack(spacing: 10) {
                                Image(systemName: "person.crop.circle.badge.questionmark")
                                    .font(.title2)
                                    .foregroundColor(.secondary)
                                Text("Sign in to sync saved artists")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                Button("Sign In") {
                                    showSignIn = true
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 20)

                            Divider()

                            // Local saved artists (offline, no sync)
                            SupportListView(
                                supportListManager: supportListManager,
                                releaseAlertManager: releaseAlertManager
                            )
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
                                NowPlayingView(
                                    nowPlaying: nowPlaying,
                                    artistImageUrl: appState.nowPlayingResults.first?.imageUrl
                                )
                                if appState.isLoadingNowPlaying {
                                    LoadingView()
                                } else if !appState.nowPlayingResults.isEmpty {
                                    ResultsView(
                                        title: nil,
                                        results: appState.nowPlayingResults,
                                        showArtistPhoto: false
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
                // Sign in/out button
                if auth.isSignedIn {
                    Button(action: { Task { await auth.signOut() } }) {
                        HStack(spacing: 4) {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .font(.system(size: 10))
                            Text("Sign Out")
                                .font(.system(size: 10))
                        }
                        .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                } else {
                    Button(action: { showSignIn = true }) {
                        HStack(spacing: 4) {
                            Image(systemName: "person.crop.circle.badge.plus")
                                .font(.system(size: 10))
                            Text("Sign In")
                                .font(.system(size: 10))
                        }
                        .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                }

                Spacer()

                Menu {
                    Button(action: {
                        AppDelegate.shared?.openSettings()
                    }) {
                        Label("Settings", systemImage: "gearshape")
                    }

                    Divider()

                    Link(destination: URL(string: "https://github.com/users/brandonlucasgreen/projects/3/views/1")!) {
                        Label("Roadmap", systemImage: "map")
                    }

                    Link(destination: URL(string: "https://letterbird.co/hi-d2078591")!) {
                        Label("Share Feedback", systemImage: "bubble.left")
                    }

                    Link(destination: URL(string: "https://unstream.stream/support")!) {
                        Label("Support", systemImage: "heart")
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
        .sheet(isPresented: $showSignIn) {
            SignInView()
        }
        .onDisappear {
            stopMenuPoll()
        }
    }

    // MARK: - 60-second poll while menu is open

    private func startMenuPoll() {
        stopMenuPoll()
        menuPollTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            Task { @MainActor in
                await sync.pull()
            }
        }
        // Periodic force-pull every 5 minutes as a safety net for
        // cross-device removals (tombstones cover the common case,
        // but a full refresh catches any edge cases during long sessions).
        menuForcePullTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
            Task { @MainActor in
                await sync.pull(force: true)
            }
        }
    }

    private func stopMenuPoll() {
        menuPollTimer?.invalidate()
        menuPollTimer = nil
        menuForcePullTimer?.invalidate()
        menuForcePullTimer = nil
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
    @StateObject private var appState = AppState()

    var body: some View {
        PopoverView()
            .environmentObject(appState)
            .environmentObject(supportList)
            .environmentObject(ReleaseAlertManager(supportListManager: supportList))
    }
}

#Preview {
    PopoverViewPreviewContainer()
}
