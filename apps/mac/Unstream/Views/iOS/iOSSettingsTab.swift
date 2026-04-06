#if os(iOS)
import SwiftUI

struct iOSSettingsTab: View {
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager
    @State private var notificationDenied = false

    var body: some View {
        NavigationStack {
            Form {
                // Release Alerts
                Section {
                    Toggle("Release Alerts", isOn: Binding(
                        get: { releaseAlertManager.releaseAlertsEnabled },
                        set: { newValue in
                            if newValue {
                                // Request notification permission before enabling
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
        }
    }
}
#endif
