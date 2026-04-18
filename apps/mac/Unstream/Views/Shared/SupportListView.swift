import SwiftUI

#if os(macOS)
import AppKit
#endif

struct SupportListView: View {
    @ObservedObject var supportListManager: SupportListManager
    @ObservedObject var releaseAlertManager: ReleaseAlertManager

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Search bar with share button
            if supportListManager.entries.count > 0 {
                HStack(spacing: 8) {
                    SavedArtistsSearchBar(supportListManager: supportListManager)

                    #if os(macOS)
                    Button(action: shareArtistList) {
                        Image(systemName: "square.and.arrow.up")
                            .foregroundColor(.secondary)
                            .font(.system(size: 14))
                    }
                    .buttonStyle(.plain)
                    .help("Share saved artists")
                    #else
                    ShareLink(item: generateShareText()) {
                        Image(systemName: "square.and.arrow.up")
                            .foregroundColor(.secondary)
                            .font(.system(size: 14))
                    }
                    #endif
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

    #if os(macOS)
    private func shareArtistList() {
        let shareText = generateShareText()
        let picker = NSSharingServicePicker(items: [shareText])
        if let window = NSApp.keyWindow,
           let contentView = window.contentView {
            let rect = NSRect(x: contentView.bounds.midX, y: contentView.bounds.maxY - 50, width: 1, height: 1)
            picker.show(relativeTo: rect, of: contentView, preferredEdge: .minY)
        }
    }
    #endif
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
        .background(searchBarBackgroundColor)
        .cornerRadius(8)
    }

    private var searchBarBackgroundColor: Color {
        #if os(macOS)
        Color(NSColor.textBackgroundColor)
        #else
        Color(.systemGray6)
        #endif
    }
}

struct SupportEntryView: View {
    let entry: SupportEntry
    let isRefreshing: Bool
    var newRelease: NewRelease?
    let onRemove: () -> Void
    let onRefresh: () -> Void

    #if os(macOS)
    @State private var isHovering = false
    #endif

    #if os(iOS)
    private let iconButtonSize: CGFloat = 44
    private let refreshIconSize: CGFloat = 18
    private let heartIconSize: CGFloat = 20
    #else
    private let iconButtonSize: CGFloat = 14
    private let refreshIconSize: CGFloat = 12
    private let heartIconSize: CGFloat = 14
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                // Artist photo
                artistPhoto

                Text(entry.artistName)
                    .font(.system(size: 14, weight: .semibold))

                Spacer()

                if isRefreshing {
                    ProgressView()
                        .scaleEffect(0.6)
                        .frame(width: iconButtonSize, height: iconButtonSize)
                } else {
                    Button(action: onRefresh) {
                        Image(systemName: "arrow.clockwise")
                            .foregroundColor(.secondary)
                            .font(.system(size: refreshIconSize))
                            .frame(width: iconButtonSize, height: iconButtonSize)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    #if os(macOS)
                    .opacity(isHovering ? 1 : 0.3)
                    .help("Refresh platforms")
                    #endif
                }

                Button(action: onRemove) {
                    Image(systemName: "heart.fill")
                        .foregroundColor(.red)
                        .font(.system(size: heartIconSize))
                        .frame(width: iconButtonSize, height: iconButtonSize)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                #if os(macOS)
                .opacity(isHovering ? 1 : 0.5)
                .help("Remove from Saved Artists")
                #endif
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
        .background(cardBackgroundColor)
        .cornerRadius(8)
        #if os(macOS)
        .onHover { hovering in
            isHovering = hovering
        }
        #endif
    }

    private var cardBackgroundColor: Color {
        #if os(macOS)
        Color(NSColor.controlBackgroundColor)
        #else
        Color(.secondarySystemGroupedBackground)
        #endif
    }

    @ViewBuilder
    private var artistPhoto: some View {
        if let imageUrl = entry.imageUrl, let url = URL(string: imageUrl) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().aspectRatio(contentMode: .fill)
                case .failure(_):
                    Image(systemName: "person.circle.fill")
                        .resizable().foregroundColor(.secondary.opacity(0.5))
                case .empty:
                    ProgressView().scaleEffect(0.5)
                @unknown default:
                    Image(systemName: "person.circle.fill")
                        .resizable().foregroundColor(.secondary.opacity(0.5))
                }
            }
            .frame(width: 36, height: 36)
            .clipShape(Circle())
        } else {
            Image(systemName: "person.circle.fill")
                .resizable()
                .foregroundColor(.secondary.opacity(0.5))
                .frame(width: 36, height: 36)
        }
    }
}

struct SavedPlatformBadge: View {
    let platform: SavedPlatform
    @Environment(\.colorScheme) var colorScheme

    #if os(iOS)
    @State private var safariItem: SafariURL?
    #endif

    private let socialPlatformIds: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "mastodon", "peertube"]
    private let brandIconPlatforms: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "mastodon", "peertube", "bandcamp"]

    private var isSocialPlatform: Bool {
        socialPlatformIds.contains(platform.sourceId)
    }

    private var platformColor: Color {
        let hex = platform.color
        if hex == "#000000" || hex == "#E0E0E0" {
            return Color(white: 0.7)
        }
        return Color(hex: hex) ?? .blue
    }

    #if os(iOS)
    private let socialBadgeSize: CGFloat = 44
    private let socialIconSize: CGFloat = 20
    private let badgeIconSize: CGFloat = 14
    private let badgeFontSize: CGFloat = 14
    private let badgePaddingH: CGFloat = 12
    private let badgePaddingV: CGFloat = 10
    private let badgeSpacing: CGFloat = 6
    #else
    private let socialBadgeSize: CGFloat = 28
    private let socialIconSize: CGFloat = 14
    private let badgeIconSize: CGFloat = 10
    private let badgeFontSize: CGFloat = 11
    private let badgePaddingH: CGFloat = 8
    private let badgePaddingV: CGFloat = 4
    private let badgeSpacing: CGFloat = 4
    #endif

    var body: some View {
        Button(action: openPlatformURL) {
            if isSocialPlatform {
                // Social platforms: icon only (circular)
                platformIcon(size: socialIconSize)
                    .frame(width: socialBadgeSize, height: socialBadgeSize)
                    .background(platformColor.opacity(0.15))
                    .cornerRadius(socialBadgeSize / 2)
            } else {
                // Regular platforms: icon + text
                HStack(spacing: badgeSpacing) {
                    platformIcon(size: badgeIconSize)
                    Text(platform.displayName)
                        .font(.system(size: badgeFontSize, weight: .medium))
                }
                .padding(.horizontal, badgePaddingH)
                .padding(.vertical, badgePaddingV)
                .background(platformColor.opacity(0.15))
                .foregroundColor(platformColor)
                .cornerRadius(6)
            }
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .help("Open \(platform.displayName)")
        #endif
        #if os(iOS)
        .safariSheet(safariItem: $safariItem)
        #endif
    }

    @ViewBuilder
    private func platformIcon(size: CGFloat) -> some View {
        if brandIconPlatforms.contains(platform.sourceId) {
            BrandIcon(
                platform: platform.sourceId,
                size: size,
                color: colorScheme == .dark ? .white : platformColor
            )
        } else {
            Image(systemName: platform.icon)
                .font(.system(size: size))
                .foregroundColor(colorScheme == .dark ? .white : platformColor)
        }
    }

    private func openPlatformURL() {
        guard let url = URL(string: platform.url) else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        safariItem = SafariURL(url: url)
        #endif
    }
}

struct NewReleaseBadge: View {
    let release: NewRelease

    #if os(iOS)
    @State private var safariItem: SafariURL?
    #endif

    #if os(iOS)
    private let fontSize: CGFloat = 14
    private let paddingH: CGFloat = 12
    private let paddingV: CGFloat = 10
    #else
    private let fontSize: CGFloat = 11
    private let paddingH: CGFloat = 8
    private let paddingV: CGFloat = 4
    #endif

    var body: some View {
        Button(action: openRelease) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundColor(.yellow)
                Text("New release: \(release.releaseName)")
                    .font(.system(size: fontSize, weight: .medium))
                    .lineLimit(1)
            }
            .padding(.horizontal, paddingH)
            .padding(.vertical, paddingV)
            .background(Color.yellow.opacity(0.15))
            .foregroundColor(.primary)
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .help("Open \(release.releaseName) on \(release.platform.capitalized)")
        #endif
        #if os(iOS)
        .safariSheet(safariItem: $safariItem)
        #endif
    }

    private func openRelease() {
        guard let url = URL(string: release.releaseUrl) else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        safariItem = SafariURL(url: url)
        #endif
    }
}
