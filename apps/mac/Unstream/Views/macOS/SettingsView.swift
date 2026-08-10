import SwiftUI
import ServiceManagement

enum SettingsTab: String, CaseIterable {
    case general = "General"
    case integrations = "Integrations"
    case about = "About"

    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .integrations: return "link"
        case .about: return "info.circle"
        }
    }
}

struct SettingsView: View {
    var releaseAlertManager: ReleaseAlertManager?
    var libraryService: AppleMusicLibraryService?

    @AppStorage("musicListeningEnabled") private var musicListeningEnabled = true
    @AppStorage("artistNotificationsEnabled") private var artistNotificationsEnabled = true
    @AppStorage("checkForUpdatesAutomatically") private var checkForUpdatesAutomatically = true
    @AppStorage("listenBrainzEnabled") private var listenBrainzEnabled = false
    @State private var launchAtLogin = false
    @State private var updateStatus: String? = nil
    @State private var updateAvailable = false
    @State private var updateDownloadUrl: String? = nil
    @State private var isCheckingForUpdates = false
    @State private var selectedTab: SettingsTab = .general

    // ListenBrainz state
    @State private var listenBrainzToken: String = ""
    @State private var listenBrainzUsername: String? = nil
    @State private var isValidatingToken = false
    @State private var tokenValidationError: String? = nil

    // Plex state
    @AppStorage("plexIntegrationEnabled") private var plexEnabled = false
    @State private var plexServerURL: String = ""
    @State private var plexToken: String = ""
    @State private var plexServerName: String? = nil
    @State private var isValidatingPlex = false
    @State private var plexValidationError: String? = nil

    // Keyboard shortcut state
    @ObservedObject private var hotkeyManager = GlobalHotkeyManager.shared
    @StateObject private var shortcutRecorder = ShortcutRecorder()

    var body: some View {
        // A real TabView inside the Settings scene renders as the standard macOS
        // settings toolbar tabs, with keyboard navigation and correct active/inactive
        // styling — the hand-rolled accent-tinted pills had none of that.
        TabView(selection: $selectedTab) {
            generalTab
                .tabItem { Label(SettingsTab.general.rawValue, systemImage: SettingsTab.general.icon) }
                .tag(SettingsTab.general)

            integrationsTab
                .tabItem { Label(SettingsTab.integrations.rawValue, systemImage: SettingsTab.integrations.icon) }
                .tag(SettingsTab.integrations)

            aboutTab
                .tabItem { Label(SettingsTab.about.rawValue, systemImage: SettingsTab.about.icon) }
                .tag(SettingsTab.about)
        }
        .frame(width: 480)
        .onAppear {
            launchAtLogin = getLaunchAtLoginStatus()
            loadListenBrainzState()
            loadPlexState()
        }
    }

    // MARK: - General Tab

    private var generalTab: some View {
        Form {
            Section {
                Toggle("Music app listening", isOn: $musicListeningEnabled)
                    .help("Automatically detect what's playing in Music or Spotify")
                Toggle("Artist detection notifications", isOn: $artistNotificationsEnabled)
                    .help("Show a notification when a new artist is detected while playing music")
            } footer: {
                Text("Unstream watches your music players so it can show where the current artist sells directly.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section {
                HStack {
                    if shortcutRecorder.isRecording {
                        Text("Press shortcut...")
                            .font(.callout.weight(.medium))
                            .foregroundColor(.accentColor)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                RoundedRectangle(cornerRadius: 6)
                                    .strokeBorder(Color.accentColor, lineWidth: 1.5)
                            )

                        Button("Cancel") {
                            shortcutRecorder.stopRecording()
                        }
                        .font(.caption)
                    } else if let shortcut = hotkeyManager.currentShortcut {
                        Text(shortcut.displayString)
                            .font(.body.weight(.medium))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(Color.primary.opacity(0.08))
                            )

                        Button("Change") {
                            startRecording()
                        }
                        .font(.caption)

                        Button("Clear") {
                            hotkeyManager.currentShortcut = nil
                            hotkeyManager.isEnabled = false
                        }
                        .font(.caption)
                        .foregroundColor(.red)
                    } else {
                        Button("Record Shortcut") {
                            startRecording()
                        }
                        .font(.caption)
                    }
                }

                if hotkeyManager.currentShortcut != nil {
                    Toggle("Enable shortcut", isOn: $hotkeyManager.isEnabled)
                }
            } header: {
                Text("Keyboard Shortcut")
            } footer: {
                Text("Set a global shortcut to open Unstream from anywhere.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section {
                Toggle("Start at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { newValue in
                        setLaunchAtLogin(newValue)
                    }
            } footer: {
                Text("Automatically launch Unstream when you log in.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    // MARK: - Integrations Tab

    private var integrationsTab: some View {
        Form {
            // Release Alerts
            if let alertManager = releaseAlertManager {
                Section {
                    Toggle("Check for new releases weekly", isOn: Binding(
                        get: { alertManager.releaseAlertsEnabled },
                        set: { alertManager.releaseAlertsEnabled = $0 }
                    ))

                    HStack {
                        if let lastCheck = alertManager.lastCheckDate {
                            Text("Last checked: \(lastCheck.formatted(.relative(presentation: .named)))")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }

                        Spacer()

                        if alertManager.isChecking {
                            ProgressView()
                                .controlSize(.small)
                        }

                        Button("Check Now") {
                            Task {
                                await alertManager.checkNow()
                            }
                        }
                        .disabled(alertManager.isChecking)
                    }

                    #if DEBUG
                    VStack(alignment: .leading, spacing: 8) {
                        Divider()
                            .padding(.vertical, 4)

                        Text("Debug Controls")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(.orange)

                        HStack(spacing: 8) {
                            Button("Clear Known") {
                                alertManager.clearKnownReleases()
                            }
                            .font(.caption)

                            Button("Reset All") {
                                alertManager.resetAllState()
                            }
                            .font(.caption)
                            .foregroundColor(.red)
                        }

                        Button("Request Notification Permission") {
                            alertManager.requestNotificationPermission()
                        }
                        .font(.caption)

                        if !alertManager.newReleases.isEmpty {
                            Text("\(alertManager.newReleases.count) new release(s) found")
                                .font(.caption)
                                .foregroundColor(.green)
                        }

                        Text("Clear Known allows re-detecting releases.")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    #endif
                } header: {
                    HStack {
                        Text("Release Alerts")
                        if alertManager.releaseAlertsEnabled {
                            Image(systemName: "bell.fill")
                                .foregroundColor(.yellow)
                                .font(.caption)
                                .accessibilityLabel("Release alerts on")
                        }
                    }
                } footer: {
                    Text("Get notified when your saved artists release new music on Bandcamp or Faircamp.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            // ListenBrainz Scrobbling
            Section {
                Toggle("Enable ListenBrainz scrobbling", isOn: $listenBrainzEnabled)
                    .onChange(of: listenBrainzEnabled) { newValue in
                        ListenBrainzService.shared.isEnabled = newValue
                    }

                if listenBrainzEnabled {
                    VStack(alignment: .leading, spacing: 8) {
                        if let username = listenBrainzUsername {
                            HStack {
                                Text("Connected as: \(username)")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                Spacer()
                                Button("Disconnect") {
                                    disconnectListenBrainz()
                                }
                                .font(.caption)
                                .foregroundColor(.red)
                            }

                            if ScrobbleManager.shared.scrobbleCount > 0 {
                                Text("Scrobble count: \(ScrobbleManager.shared.scrobbleCount)")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        } else {
                            HStack {
                                SecureField("User token", text: $listenBrainzToken)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(maxWidth: 180)

                                Button(isValidatingToken ? "..." : "Connect") {
                                    validateListenBrainzToken()
                                }
                                .disabled(listenBrainzToken.isEmpty || isValidatingToken)
                            }

                            if let error = tokenValidationError {
                                Text(error)
                                    .font(.caption)
                                    .foregroundColor(.red)
                            }

                            Link("Get your token from ListenBrainz", destination: URL(string: "https://listenbrainz.org/settings/")!)
                                .font(.caption)
                        }
                    }
                }
            } header: {
                HStack {
                    Text("Scrobbling")
                    if listenBrainzUsername != nil {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                            .font(.caption)
                            .accessibilityLabel("ListenBrainz connected")
                    }
                }
            } footer: {
                Text("Submit your listening history to ListenBrainz.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            // Apple Music library import (support-loop-spec.md Step 2)
            if let libraryService {
                MusicLibrarySettingsSection(service: libraryService)
            }

            // Plex Integration
            Section {
                Toggle("Enable Plex music detection", isOn: $plexEnabled)
                    .onChange(of: plexEnabled) { newValue in
                        PlexService.shared.isEnabled = newValue
                    }

                if plexEnabled {
                    if let serverName = plexServerName {
                        LabeledContent("Connected to") {
                            HStack {
                                Text(serverName)
                                    .foregroundColor(.secondary)
                                Spacer()
                                Button("Disconnect") {
                                    disconnectPlex()
                                }
                            }
                        }
                    } else {
                        // Form gives these right-aligned native labels; the old version
                        // hand-rolled them with fixed-width Text + HStack.
                        TextField("Server URL", text: $plexServerURL, prompt: Text("http://localhost:32400"))
                        SecureField("Token", text: $plexToken, prompt: Text("Plex auth token"))

                        HStack {
                            Spacer()
                            if isValidatingPlex {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Button(isValidatingPlex ? "Connecting…" : "Connect") {
                                validatePlexConnection()
                            }
                            .disabled(plexToken.isEmpty || isValidatingPlex)
                        }

                        if let error = plexValidationError {
                            Text(error)
                                .font(.caption)
                                .foregroundColor(.red)
                        }

                        Link("How to find your Plex token",
                             destination: URL(string: "https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/")!)
                            .font(.caption)
                    }
                }
            } header: {
                HStack {
                    Text("Plex")
                    if plexServerName != nil {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                            .font(.caption)
                            .accessibilityLabel("Plex connected")
                    }
                }
            } footer: {
                Text("Detect music playing on your Plex server (Plexamp, Plex Web, etc.).")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
        .onReceive(NotificationCenter.default.publisher(for: .plexAuthError)) { _ in
            plexServerName = nil
            plexValidationError = "Plex token is invalid or expired. Please reconnect."
        }
    }

    // MARK: - About Tab

    private var aboutTab: some View {
        Form {
            // Updates
            Section("Updates") {
                Toggle("Check for updates automatically", isOn: $checkForUpdatesAutomatically)

                HStack {
                    Button("Check for Updates") {
                        checkForUpdates()
                    }
                    .disabled(isCheckingForUpdates)

                    if isCheckingForUpdates {
                        ProgressView()
                            .controlSize(.small)
                    }

                    Spacer()
                }

                if let status = updateStatus {
                    HStack(spacing: 4) {
                        if updateAvailable {
                            Image(systemName: "arrow.down.circle.fill")
                                .foregroundColor(.blue)
                        } else {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                        }
                        Text(status)
                            .font(.caption)
                            .foregroundColor(updateAvailable ? .primary : .secondary)
                    }

                    if updateAvailable, let url = updateDownloadUrl, let downloadURL = URL(string: url) {
                        Link(destination: downloadURL) {
                            HStack(spacing: 4) {
                                Image(systemName: "arrow.down.to.line")
                                Text("Download Update")
                            }
                            .font(.caption)
                        }
                    }
                }
            }

            // Support Unstream
            Section {
                TipJarView()
            } header: {
                Text("Support Unstream")
            } footer: {
                Text("Unstream is free and open source. If you find it useful, consider supporting development.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            // About
            Section {
                LabeledContent("Version", value: Bundle.main.appVersion)
                Link("Visit unstream.stream", destination: URL(string: "https://unstream.stream")!)
            }
        }
        .formStyle(.grouped)
    }

    // MARK: - Keyboard Shortcut

    private func startRecording() {
        shortcutRecorder.onShortcutCaptured = { newShortcut in
            hotkeyManager.currentShortcut = newShortcut
            if !hotkeyManager.isEnabled {
                hotkeyManager.isEnabled = true
            }
        }
        shortcutRecorder.onCancel = nil
        shortcutRecorder.startRecording()
    }

    // MARK: - ListenBrainz Functions

    private func loadListenBrainzState() {
        listenBrainzToken = ListenBrainzService.shared.userToken ?? ""

        // If we have a token, validate it to get the username
        if !listenBrainzToken.isEmpty {
            validateListenBrainzToken()
        }
    }

    private func validateListenBrainzToken() {
        isValidatingToken = true
        tokenValidationError = nil

        // Save the token first
        ListenBrainzService.shared.userToken = listenBrainzToken

        ListenBrainzService.shared.validateToken { result in
            DispatchQueue.main.async {
                isValidatingToken = false
                switch result {
                case .success(let username):
                    listenBrainzUsername = username
                    tokenValidationError = nil
                case .failure(let error):
                    listenBrainzUsername = nil
                    tokenValidationError = error.localizedDescription
                    // Clear invalid token
                    if case ListenBrainzError.invalidToken = error {
                        ListenBrainzService.shared.userToken = nil
                    }
                }
            }
        }
    }

    // MARK: - Plex Functions

    private func loadPlexState() {
        plexServerURL = PlexService.shared.serverURL
        plexToken = PlexService.shared.authToken ?? ""

        // If we have a token, validate the connection to get server name
        if !plexToken.isEmpty && plexEnabled {
            validatePlexConnection()
        }
    }

    private func validatePlexConnection() {
        isValidatingPlex = true
        plexValidationError = nil

        // Save config before validating
        PlexService.shared.serverURL = plexServerURL
        PlexService.shared.authToken = plexToken

        PlexService.shared.validateConnection { result in
            DispatchQueue.main.async {
                isValidatingPlex = false
                switch result {
                case .success(let serverName):
                    plexServerName = serverName
                    plexValidationError = nil
                    PlexService.shared.isEnabled = true
                    plexEnabled = true
                case .failure(let error):
                    plexServerName = nil
                    plexValidationError = error.localizedDescription
                    if case .unauthorized = error {
                        // Clear invalid token from Keychain
                        PlexService.shared.authToken = nil
                        plexToken = ""
                    }
                }
            }
        }
    }

    private func disconnectPlex() {
        PlexService.shared.disconnect()
        plexServerURL = ""
        plexToken = ""
        plexServerName = nil
        plexValidationError = nil
        plexEnabled = false
    }

    private func disconnectListenBrainz() {
        ListenBrainzService.shared.userToken = nil
        ListenBrainzService.shared.isEnabled = false
        listenBrainzToken = ""
        listenBrainzUsername = nil
        listenBrainzEnabled = false
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            print("[Settings] Failed to set launch at login: \(error)")
        }
    }

    private func getLaunchAtLoginStatus() -> Bool {
        return SMAppService.mainApp.status == .enabled
    }

    private func checkForUpdates() {
        isCheckingForUpdates = true
        updateStatus = nil
        updateAvailable = false
        updateDownloadUrl = nil

        Task {
            do {
                let result = try await UpdateChecker.shared.checkForUpdates()
                await MainActor.run {
                    updateStatus = result.message
                    updateAvailable = result.updateAvailable
                    updateDownloadUrl = result.downloadUrl
                    isCheckingForUpdates = false
                }
            } catch {
                await MainActor.run {
                    updateStatus = "Failed to check for updates"
                    updateAvailable = false
                    updateDownloadUrl = nil
                    isCheckingForUpdates = false
                }
            }
        }
    }
}

// Extension to get app version
extension Bundle {
    var appVersion: String {
        return infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
    }
}

#Preview {
    SettingsView()
}
