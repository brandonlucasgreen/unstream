import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @ObservedObject var licenseManager: LicenseManager

    @AppStorage("musicListeningEnabled") private var musicListeningEnabled = true
    @AppStorage("checkForUpdatesAutomatically") private var checkForUpdatesAutomatically = true
    @State private var launchAtLogin = false
    @State private var updateStatus: String? = nil
    @State private var updateAvailable = false
    @State private var updateDownloadUrl: String? = nil
    @State private var isCheckingForUpdates = false
    @State private var licenseKeyInput: String = ""

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

            // Music Listening
            VStack(alignment: .leading, spacing: 4) {
                Toggle("Music app listening", isOn: $musicListeningEnabled)
                Text("Automatically detect what's playing in Music or Spotify")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

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
        .frame(width: 320, height: 420)
        .onAppear {
            launchAtLogin = getLaunchAtLoginStatus()
            licenseKeyInput = licenseManager.licenseKey
        }
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
