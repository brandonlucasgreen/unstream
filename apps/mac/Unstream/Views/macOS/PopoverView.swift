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
    @State private var pollTask: Task<Void, Never>?
    @FocusState private var searchFieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // A real segmented control: correct selection emphasis in both appearances
            // and in an inactive window, which the hand-rolled accent-tinted pills got
            // wrong (they read as a heavy blue slab in dark mode).
            Picker("View", selection: $selectedTab) {
                Text("Search").tag(PopoverTab.search)
                Text(savedTabTitle).tag(PopoverTab.supportList)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.top, 10)

            // Search bar (only visible on search tab)
            if selectedTab == .search {
                SearchBarView(isFocused: $searchFieldFocused)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 12)
            } else {
                Spacer().frame(height: 10)
            }

            Divider()

            // Content area
            ScrollView {
                VStack(spacing: 12) {
                    if selectedTab == .supportList {
                        // Synced artists from server (if signed in)
                        if auth.isSignedIn {
                            SyncedArtistsView(onSearchArtist: { name in
                                appState.searchQuery = name
                                appState.clearResults()
                                Task { await appState.performSearch() }
                                selectedTab = .search
                            })
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
                    // Account identity lives next to the sign-out action rather than in
                    // a bar above the search field, where it competed with the task.
                    Button(action: { Task { await auth.signOut() } }) {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Sign out of \(auth.userEmail ?? "Unstream")")
                    .accessibilityLabel("Sign out of \(auth.userEmail ?? "Unstream")")

                    if let email = auth.userEmail {
                        Text(email)
                            .font(.caption2)
                            .foregroundColor(.secondary.opacity(0.7))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help("Signed in as \(email)")
                            .accessibilityHidden(true)
                    }
                } else {
                    Button(action: { showSignIn = true }) {
                        Label("Sign In", systemImage: "person.crop.circle.badge.plus")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Sign in to sync saved artists")
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
                        .font(.title3)
                        .foregroundColor(.secondary)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("More options")
                .help("Settings, feedback, and more")
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .frame(width: 320)
        .background(keyboardShortcuts)
        .sheet(isPresented: $showSignIn) {
            SignInView()
        }
        .onAppear {
            // Reset sheet state on every open — NSPopover hides (not destroys) its content
            // view, so onDisappear isn't reliable; onAppear fires on each show.
            showSignIn = false
            focusSearchField()
        }
        .onChange(of: selectedTab) { tab in
            if tab == .search { focusSearchField() }
        }
        .onDisappear {
            stopMenuPoll()
            showSignIn = false
        }
        .onReceive(NotificationCenter.default.publisher(for: .popoverDidClose)) { _ in
            // NSPopoverDelegate fires this unconditionally when the popover closes.
            showSignIn = false
        }
        .onReceive(NotificationCenter.default.publisher(for: .showSearchTab)) { _ in
            selectedTab = .search
        }
        .onChange(of: auth.isSignedIn) { signedIn in
            if !signedIn {
                stopMenuPoll()
            }
        }
    }

    /// The saved count rides in the segment label — a segmented control has no badge
    /// slot, and the count is useful enough to keep.
    private var savedTabTitle: String {
        let count = supportListManager.entries.count
        return count > 0 ? "Saved (\(count))" : "Saved"
    }

    // MARK: - Keyboard

    /// The popover's window only becomes key just *after* `show()`, so focusing
    /// synchronously in `onAppear` gets discarded. Defer one run-loop turn.
    private func focusSearchField() {
        DispatchQueue.main.async {
            searchFieldFocused = true
        }
    }

    /// The popover is a hosted view, not a Scene, so there's no `Commands` builder to
    /// hang shortcuts on. Zero-size buttons are the standard SwiftUI way to register
    /// key equivalents inside one; they only fire while the popover is the key window.
    private var keyboardShortcuts: some View {
        Group {
            Button("Search") {
                selectedTab = .search
                focusSearchField()
            }
            .keyboardShortcut("f", modifiers: .command)

            Button("Search Tab") { selectedTab = .search }
                .keyboardShortcut("1", modifiers: .command)

            Button("Saved Artists Tab") { selectedTab = .supportList }
                .keyboardShortcut("2", modifiers: .command)

            Button("Close") { AppDelegate.shared?.closePopover() }
                .keyboardShortcut("w", modifiers: .command)
        }
        .frame(width: 0, height: 0)
        .opacity(0)
        .accessibilityHidden(true)
    }

    // MARK: - 60-second poll while menu is open

    private func startMenuPoll() {
        stopMenuPoll()
        var iterationCount = 0
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { break }
                iterationCount += 1
                let force = iterationCount % 5 == 0  // every 5th iteration = 5 minutes
                await sync.pull(force: force)
            }
        }
    }

    private func stopMenuPoll() {
        pollTask?.cancel()
        pollTask = nil
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
