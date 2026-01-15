import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @ObservedObject var licenseManager: LicenseManager
    var releaseAlertManager: ReleaseAlertManager?

    @AppStorage("musicListeningEnabled") private var musicListeningEnabled = true
    @AppStorage("checkForUpdatesAutomatically") private var checkForUpdatesAutomatically = true
    @AppStorage("listenBrainzEnabled") private var listenBrainzEnabled = false
    @State private var launchAtLogin = false
    @State private var updateStatus: String? = nil
    @State private var updateAvailable = false
    @State private var updateDownloadUrl: String? = nil
    @State private var isCheckingForUpdates = false
    @State private var licenseKeyInput: String = ""

    // ListenBrainz state
    @State private var listenBrainzToken: String = ""
    @State private var listenBrainzUsername: String? = nil
    @State private var isValidatingToken = false
    @State private var tokenValidationError: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
                .frame(height: 8)

            // Pro License Section
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Unstream Plus")
                        .font(.headline)
                    if licenseManager.isPro {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundColor(.green)
                    }
                }

                if licenseManager.isPro {
                    // Licensed state
                    VStack(alignment: .leading, spacing: 4) {
                        if let email = licenseManager.customerEmail {
                            Text("Licensed to: \(email)")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Button("Remove License") {
                            licenseManager.clearLicense()
                            licenseKeyInput = ""
                        }
                        .font(.caption)
                        .foregroundColor(.red)
                    }
                } else {
                    // Unlicensed state
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Unlock the Saved Artists feature to keep track of artists you want to support.")
                            .font(.caption)
                            .foregroundColor(.secondary)

                        HStack {
                            TextField("License key", text: $licenseKeyInput)
                                .textFieldStyle(.roundedBorder)
                                .frame(maxWidth: 200)

                            Button(licenseManager.isValidating ? "..." : "Activate") {
                                Task {
                                    await licenseManager.validateLicense(key: licenseKeyInput)
                                }
                            }
                            .disabled(licenseKeyInput.isEmpty || licenseManager.isValidating)
                        }

                        if let error = licenseManager.validationError {
                            Text(error)
                                .font(.caption)
                                .foregroundColor(.red)
                        }

                        Link("Purchase a license", destination: URL(string: "https://unstream.stream/plus")!)
                            .font(.caption)
                    }
                }
            }

            Divider()

            // Release Alerts (Pro feature)
            if licenseManager.isPro, let alertManager = releaseAlertManager {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Release Alerts")
                            .font(.headline)
                        if alertManager.releaseAlertsEnabled {
                            Image(systemName: "bell.fill")
                                .foregroundColor(.yellow)
                                .font(.caption)
                        }
                    }

                    Toggle("Check for new releases weekly", isOn: Binding(
                        get: { alertManager.releaseAlertsEnabled },
                        set: { alertManager.releaseAlertsEnabled = $0 }
                    ))

                    Text("Get notified when your saved artists release new music on Bandcamp or Faircamp.")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    if let lastCheck = alertManager.lastCheckDate {
                        Text("Last checked: \(lastCheck.formatted(.relative(presentation: .named)))")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    #if DEBUG
                    // Debug controls for testing
                    VStack(alignment: .leading, spacing: 8) {
                        Divider()
                            .padding(.vertical, 4)

                        Text("Debug Controls")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(.orange)

                        HStack {
                            Button("Check Now") {
                                Task {
                                    await alertManager.checkNow()
                                }
                            }
                            .disabled(alertManager.isChecking)

                            if alertManager.isChecking {
                                ProgressView()
                                    .scaleEffect(0.6)
                            }
                        }

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

                        Text("Check Now triggers immediate check. Clear Known allows re-detecting releases.")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    #endif
                }

                Divider()
            }

            // ListenBrainz Scrobbling
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Scrobbling")
                        .font(.headline)
                    if listenBrainzUsername != nil {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                            .font(.caption)
                    }
                }

                Toggle("Enable ListenBrainz scrobbling", isOn: $listenBrainzEnabled)
                    .onChange(of: listenBrainzEnabled) { newValue in
                        ListenBrainzService.shared.isEnabled = newValue
                    }

                Text("Submit your listening history to ListenBrainz")
                    .font(.caption)
                    .foregroundColor(.secondary)

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
            }

            Divider()

            // Music Listening
            VStack(alignment: .leading, spacing: 4) {
                Toggle("Music app listening", isOn: $musicListeningEnabled)
                Text("Automatically detect what's playing in Music or Spotify")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Divider()

            // Launch at Login
            VStack(alignment: .leading, spacing: 4) {
                Toggle("Start at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { newValue in
                        setLaunchAtLogin(newValue)
                    }
                Text("Automatically launch Unstream when you log in")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Divider()

            // Updates
            VStack(alignment: .leading, spacing: 8) {
                Toggle("Check for updates automatically", isOn: $checkForUpdatesAutomatically)

                HStack {
                    Button("Check for Updates") {
                        checkForUpdates()
                    }
                    .disabled(isCheckingForUpdates)

                    if isCheckingForUpdates {
                        ProgressView()
                            .scaleEffect(0.7)
                    }
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

            Divider()

            // About
            VStack(alignment: .leading, spacing: 4) {
                Text("Unstream v\(Bundle.main.appVersion)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Link("Visit unstream.stream", destination: URL(string: "https://unstream.stream")!)
                    .font(.caption)
            }

            Spacer()
        }
        .padding()
        .frame(width: 320)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear {
            launchAtLogin = getLaunchAtLoginStatus()
            licenseKeyInput = licenseManager.licenseKey
            loadListenBrainzState()
        }
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
    SettingsView(licenseManager: LicenseManager())
}
