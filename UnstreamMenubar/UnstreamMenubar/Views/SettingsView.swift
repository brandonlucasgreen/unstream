import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @AppStorage("musicListeningEnabled") private var musicListeningEnabled = true
    @AppStorage("checkForUpdatesAutomatically") private var checkForUpdatesAutomatically = true
    @State private var launchAtLogin = false
    @State private var updateStatus: String? = nil
    @State private var isCheckingForUpdates = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Spacer()
                .frame(height: 8)

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
                    Button("Check for Updates Now") {
                        checkForUpdates()
                    }
                    .disabled(isCheckingForUpdates)

                    if isCheckingForUpdates {
                        ProgressView()
                            .scaleEffect(0.7)
                    }
                }

                if let status = updateStatus {
                    Text(status)
                        .font(.caption)
                        .foregroundColor(status.contains("available") ? .blue : .secondary)
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
        .frame(width: 320, height: 280)
        .onAppear {
            launchAtLogin = getLaunchAtLoginStatus()
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

        Task {
            do {
                let status = try await UpdateChecker.shared.checkForUpdates()
                await MainActor.run {
                    updateStatus = status
                    isCheckingForUpdates = false
                }
            } catch {
                await MainActor.run {
                    updateStatus = "Failed to check for updates"
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
