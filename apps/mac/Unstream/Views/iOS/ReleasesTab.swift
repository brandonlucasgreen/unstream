#if os(iOS)
import SwiftUI

struct ReleasesTab: View {
    @EnvironmentObject var releaseAlertManager: ReleaseAlertManager

    var body: some View {
        NavigationStack {
            Group {
                if releaseAlertManager.newReleases.isEmpty {
                    VStack(spacing: 16) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 48))
                            .foregroundColor(.secondary.opacity(0.5))

                        Text("No new releases")
                            .font(.headline)
                            .foregroundColor(.secondary)

                        if releaseAlertManager.releaseAlertsEnabled {
                            Text("We check your saved artists weekly.\nNew releases will appear here.")
                                .font(.subheadline)
                                .foregroundColor(.secondary.opacity(0.7))
                                .multilineTextAlignment(.center)

                            if let lastCheck = releaseAlertManager.lastCheckDate {
                                Text("Last checked \(lastCheck.formatted(.relative(presentation: .named)))")
                                    .font(.caption)
                                    .foregroundColor(.secondary.opacity(0.5))
                            }
                        } else {
                            Text("Enable release alerts in Settings\nto get notified about new music.")
                                .font(.subheadline)
                                .foregroundColor(.secondary.opacity(0.7))
                                .multilineTextAlignment(.center)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding()
                } else {
                    List {
                        ForEach(releaseAlertManager.newReleases) { release in
                            ReleaseRow(release: release)
                                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                                .listRowSeparator(.hidden)
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button(role: .destructive) {
                                        releaseAlertManager.dismissRelease(release)
                                    } label: {
                                        Label("Dismiss", systemImage: "xmark.circle")
                                    }
                                }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Releases")
            .toolbar {
                if releaseAlertManager.releaseAlertsEnabled {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Task { await releaseAlertManager.checkNow() }
                        } label: {
                            if releaseAlertManager.isChecking {
                                ProgressView()
                            } else {
                                Image(systemName: "arrow.clockwise")
                            }
                        }
                        .disabled(releaseAlertManager.isChecking)
                    }
                }
            }
        }
    }
}

private struct ReleaseRow: View {
    let release: NewRelease
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            if let url = URL(string: release.releaseUrl) {
                openURL(url)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "sparkles")
                    .foregroundColor(.yellow)
                    .font(.title3)

                VStack(alignment: .leading, spacing: 4) {
                    Text(release.artistName)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.primary)
                    Text(release.releaseName)
                        .font(.subheadline)
                        .foregroundColor(.primary)
                    Text("on \(release.platform.capitalized)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Spacer()

                Image(systemName: "arrow.up.right")
                    .foregroundColor(.secondary)
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(10)
        }
        .buttonStyle(.plain)
    }
}
#endif
