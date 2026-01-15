import SwiftUI
import AppKit

struct SupportListView: View {
    @ObservedObject var supportListManager: SupportListManager
    @ObservedObject var releaseAlertManager: ReleaseAlertManager

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Search bar with share button
            if supportListManager.entries.count > 0 {
                HStack(spacing: 8) {
                    SavedArtistsSearchBar(supportListManager: supportListManager)

                    Button(action: shareArtistList) {
                        Image(systemName: "square.and.arrow.up")
                            .foregroundColor(.secondary)
                            .font(.system(size: 14))
                    }
                    .buttonStyle(.plain)
                    .help("Share saved artists")
                }
            }

            if supportListManager.entries.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "heart.slash")
                        .font(.title2)
                        .foregroundColor(.secondary)
                    Text("No artists saved yet")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("Search for artists and tap the heart to add them here.")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.7))
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 20)
            } else if supportListManager.filteredEntries.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.title2)
                        .foregroundColor(.secondary)
                    Text("No matches found")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("Try a different search term.")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.7))
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 20)
            } else {
                ForEach(supportListManager.filteredEntries) { entry in
                    SupportEntryView(
                        entry: entry,
                        isRefreshing: supportListManager.isRefreshing(entry),
                        newRelease: releaseAlertManager.newRelease(for: entry.artistName),
                        onRemove: {
                            supportListManager.removeEntry(entry)
                        },
                        onRefresh: {
                            Task {
                                await supportListManager.refreshEntry(entry)
                            }
                        }
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func shareArtistList() {
        let shareText = generateShareText()

        let picker = NSSharingServicePicker(items: [shareText])
        if let window = NSApp.keyWindow,
           let contentView = window.contentView {
            // Show the picker near the top of the window
            let rect = NSRect(x: contentView.bounds.midX, y: contentView.bounds.maxY - 50, width: 1, height: 1)
            picker.show(relativeTo: rect, of: contentView, preferredEdge: .minY)
        }
    }

    private func generateShareText() -> String {
        var text = "My Saved Unstream Artists\n"

        for entry in supportListManager.entries {
            text += "\n\(entry.artistName)\n"
            for platform in entry.platforms {
                text += "- \(platform.displayName): \(platform.url)\n"
            }
        }

        return text
    }
}

struct SavedArtistsSearchBar: View {
    @ObservedObject var supportListManager: SupportListManager

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)
                .font(.system(size: 14))

            TextField("Filter saved artists...", text: $supportListManager.searchQuery)
                .textFieldStyle(.plain)
                .font(.system(size: 14))

            if !supportListManager.searchQuery.isEmpty {
                Button(action: {
                    supportListManager.clearSearch()
                }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                        .font(.system(size: 14))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(NSColor.textBackgroundColor))
        .cornerRadius(8)
    }
}

struct SupportEntryView: View {
    let entry: SupportEntry
    let isRefreshing: Bool
    var newRelease: NewRelease?
    let onRemove: () -> Void
    let onRefresh: () -> Void

    @State private var isHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(entry.artistName)
                    .font(.system(size: 14, weight: .semibold))

                Spacer()

                if isRefreshing {
                    ProgressView()
                        .scaleEffect(0.6)
                        .frame(width: 14, height: 14)
                } else {
                    Button(action: onRefresh) {
                        Image(systemName: "arrow.clockwise")
                            .foregroundColor(.secondary)
                            .font(.system(size: 12))
                    }
                    .buttonStyle(.plain)
                    .opacity(isHovering ? 1 : 0.3)
                    .help("Refresh platforms")
                }

                Button(action: onRemove) {
                    Image(systemName: "heart.fill")
                        .foregroundColor(.red)
                        .font(.system(size: 14))
                }
                .buttonStyle(.plain)
                .opacity(isHovering ? 1 : 0.5)
                .help("Remove from Saved Artists")
            }

            // New release indicator
            if let release = newRelease {
                NewReleaseBadge(release: release)
            }

            if !entry.platforms.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(entry.platforms) { platform in
                        SavedPlatformBadge(platform: platform)
                    }
                }
            }

            // Added date
            Text("Added \(entry.dateAdded.formatted(.relative(presentation: .named)))")
                .font(.caption2)
                .foregroundColor(.secondary.opacity(0.7))
        }
        .padding(10)
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(8)
        .onHover { hovering in
            isHovering = hovering
        }
    }
}

struct SavedPlatformBadge: View {
    let platform: SavedPlatform
    @Environment(\.colorScheme) var colorScheme

    // Social platforms show only icons (no text) to reduce clutter
    private let socialPlatformIds: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "mastodon"]

    // Platforms that have brand SVG icons
    private let brandIconPlatforms: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "mastodon", "bandcamp"]

    private var isSocialPlatform: Bool {
        socialPlatformIds.contains(platform.sourceId)
    }

    private var platformColor: Color {
        // Use light gray for black/dark icons (better visibility on dark backgrounds)
        let hex = platform.color
        if hex == "#000000" || hex == "#E0E0E0" {
            return Color(white: 0.7)
        }
        return Color(hex: hex) ?? .blue
    }

    var body: some View {
        Button(action: openURL) {
            if isSocialPlatform {
                // Social platforms: icon only (circular)
                Group {
                    if let url = Bundle.main.url(forResource: platform.sourceId, withExtension: "svg"),
                       let nsImage = NSImage(contentsOf: url) {
                        Image(nsImage: nsImage)
                            .renderingMode(.template)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 14, height: 14)
                            .foregroundColor(colorScheme == .dark ? .white : platformColor)
                    } else {
                        Image(systemName: platform.icon)
                            .font(.system(size: 14))
                            .foregroundColor(colorScheme == .dark ? .white : platformColor)
                    }
                }
                .frame(width: 28, height: 28)
                .background(platformColor.opacity(0.15))
                .cornerRadius(14)
            } else {
                // Regular platforms: icon + text
                HStack(spacing: 4) {
                    if brandIconPlatforms.contains(platform.sourceId),
                       let url = Bundle.main.url(forResource: platform.sourceId, withExtension: "svg"),
                       let nsImage = NSImage(contentsOf: url) {
                        Image(nsImage: nsImage)
                            .renderingMode(.template)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 10, height: 10)
                    } else {
                        Image(systemName: platform.icon)
                            .font(.system(size: 10))
                    }
                    Text(platform.displayName)
                        .font(.system(size: 11, weight: .medium))
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(platformColor.opacity(0.15))
                .foregroundColor(platformColor)
                .cornerRadius(6)
            }
        }
        .buttonStyle(.plain)
        .help("Open \(platform.displayName)")
    }

    private func openURL() {
        guard let url = URL(string: platform.url) else { return }
        NSWorkspace.shared.open(url)
    }
}

struct NewReleaseBadge: View {
    let release: NewRelease

    var body: some View {
        Button(action: openRelease) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundColor(.yellow)
                Text("New release: \(release.releaseName)")
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.yellow.opacity(0.15))
            .foregroundColor(.primary)
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
        .help("Open \(release.releaseName) on \(release.platform.capitalized)")
    }

    private func openRelease() {
        guard let url = URL(string: release.releaseUrl) else { return }
        NSWorkspace.shared.open(url)
    }
}

private struct SupportListViewPreviewContainer: View {
    @StateObject private var supportList = SupportListManager()
    @StateObject private var license = LicenseManager()

    var body: some View {
        SupportListView(
            supportListManager: supportList,
            releaseAlertManager: ReleaseAlertManager(supportListManager: supportList, licenseManager: license)
        )
        .padding()
        .frame(width: 300)
    }
}

#Preview {
    SupportListViewPreviewContainer()
}
