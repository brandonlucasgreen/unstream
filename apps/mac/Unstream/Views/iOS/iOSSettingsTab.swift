#if os(iOS)
import SwiftUI

struct iOSSettingsTab: View {
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager
    @ObservedObject private var auth = AuthService.shared
    @ObservedObject private var sync = SavedArtistsSync.shared
    @State private var notificationDenied = false
    @State private var showSignIn = false
    @State private var foregroundPollTimer: Timer?
    @State private var foregroundForcePullTimer: Timer?

    var body: some View {
        NavigationStack {
            Form {
                // Account / Auth
                Section {
                    if auth.isSignedIn {
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                            Text(auth.userEmail ?? "Signed in")
                                .font(.body)
                            Spacer()
                        }
                        Button("Sign Out", role: .destructive) {
                            Task { await auth.signOut() }
                        }
                    } else {
                        Button(action: { showSignIn = true }) {
                            HStack {
                                Image(systemName: "person.crop.circle.badge.plus")
                                Text("Sign In to Sync")
                            }
                        }
                    }
                } header: {
                    Text("Account")
                } footer: {
                    Text("Sign in to sync your saved artists across devices.")
                }

                // Synced saved artists (only when signed in)
                if auth.isSignedIn {
                    Section {
                        if sync.syncedArtists.isEmpty {
                            if sync.isSyncing {
                                HStack {
                                    Spacer()
                                    ProgressView()
                                        .scaleEffect(0.7)
                                    Text("Syncing...")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                    Spacer()
                                }
                            } else {
                                Text("No saved artists yet")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        } else {
                            ForEach(sync.syncedArtists) { artist in
                                SyncedArtistRow(artist: artist) {
                                    Task { await sync.removeArtist(slug: artist.displaySlug) }
                                }
                            }
                        }
                    } header: {
                        Text("Saved Artists (Synced)")
                    } footer: {
                        Text("Artists you save on any device appear here automatically.")
                    }
                }

                // Release Alerts
                Section {
                    Toggle("Release Alerts", isOn: Binding(
                        get: { releaseAlertManager.releaseAlertsEnabled },
                        set: { newValue in
                            if newValue {
                                Task {
                                    let center = UNUserNotificationCenter.current()
                                    let settings = await center.notificationSettings()

                                    if settings.authorizationStatus == .notDetermined {
                                        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                                        if !granted {
                                            notificationDenied = true
                                            return
                                        }
                                    } else if settings.authorizationStatus == .denied {
                                        notificationDenied = true
                                        return
                                    }

                                    notificationDenied = false
                                    releaseAlertManager.releaseAlertsEnabled = true
                                }
                            } else {
                                notificationDenied = false
                                releaseAlertManager.releaseAlertsEnabled = false
                            }
                        }
                    ))

                    if notificationDenied {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundColor(.orange)
                                .font(.caption)
                            Text("Notifications are disabled. Enable them in Settings > Unstream.")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }

                    if releaseAlertManager.releaseAlertsEnabled {
                        if let lastCheck = releaseAlertManager.lastCheckDate {
                            HStack {
                                Text("Last checked")
                                Spacer()
                                Text(lastCheck.formatted(.relative(presentation: .named)))
                                    .foregroundColor(.secondary)
                            }
                        }

                        HStack {
                            Spacer()
                            Button {
                                Task {
                                    await releaseAlertManager.checkNow()
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    if releaseAlertManager.isChecking {
                                        ProgressView()
                                            .scaleEffect(0.7)
                                    }
                                    Text(releaseAlertManager.isChecking ? "Checking..." : "Check Now")
                                }
                            }
                            .disabled(releaseAlertManager.isChecking)
                        }
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("Checks your saved artists weekly for new releases on Bandcamp, Faircamp, Mirlo, and Qobuz.")
                }

                // Tip Jar
                Section {
                    TipJarView()
                } header: {
                    Text("Support Unstream")
                } footer: {
                    Text("Unstream is free and open source. Tips help cover server and development costs.")
                }

                // About
                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                            .foregroundColor(.secondary)
                    }

                    Link(destination: URL(string: "https://unstream.stream")!) {
                        HStack {
                            Text("Website")
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .foregroundColor(.secondary)
                        }
                    }

                    Link(destination: URL(string: "https://github.com/brandonlucasgreen/unstream")!) {
                        HStack {
                            Text("Source Code")
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .foregroundColor(.secondary)
                        }
                    }

                    Link(destination: URL(string: "https://unstream.stream/support")!) {
                        HStack {
                            Text("Feedback")
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showSignIn) {
                SignInView()
            }
            .onAppear {
                if auth.isSignedIn {
                    Task { await sync.pull() }
                    startForegroundPoll()
                }
            }
            .onDisappear {
                stopForegroundPoll()
            }
        }
    }

    // MARK: - 60-second poll while foregrounded

    private func startForegroundPoll() {
        stopForegroundPoll()
        foregroundPollTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            Task { @MainActor in
                await sync.pull()
            }
        }
        // Periodic force-pull every 5 minutes as a safety net for
        // cross-device removals (tombstones cover the common case,
        // but a full refresh catches any edge cases during long sessions).
        foregroundForcePullTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
            Task { @MainActor in
                await sync.pull(force: true)
            }
        }
    }

    private func stopForegroundPoll() {
        foregroundPollTimer?.invalidate()
        foregroundPollTimer = nil
        foregroundForcePullTimer?.invalidate()
        foregroundForcePullTimer = nil
    }
}
#endif
