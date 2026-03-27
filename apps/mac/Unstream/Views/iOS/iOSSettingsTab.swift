#if os(iOS)
import SwiftUI

struct iOSSettingsTab: View {
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager

    var body: some View {
        NavigationStack {
            Form {
                // Release Alerts
                Section {
                    Toggle("Release Alerts", isOn: $releaseAlertManager.releaseAlertsEnabled)

                    if releaseAlertManager.releaseAlertsEnabled {
                        if let lastCheck = releaseAlertManager.lastCheckDate {
                            HStack {
                                Text("Last checked")
                                Spacer()
                                Text(lastCheck.formatted(.relative(presentation: .named)))
                                    .foregroundColor(.secondary)
                            }
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
