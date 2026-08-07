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

                    ShareLink(item: generateShareText()) {
                        Image(systemName: "square.and.arrow.up")
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Share saved artists")
                    #if os(macOS)
                    .help("Share saved artists")
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
                        newReleases: releaseAlertManager.newReleases(for: entry.artistName),
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
}

struct SavedArtistsSearchBar: View {
    @ObservedObject var supportListManager: SupportListManager

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)
                .accessibilityHidden(true)

            TextField("Filter saved artists…", text: $supportListManager.searchQuery)
                .textFieldStyle(.plain)
                .accessibilityLabel("Filter saved artists")

            if !supportListManager.searchQuery.isEmpty {
                Button(action: {
                    supportListManager.clearSearch()
                }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear filter")
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
    /// All of this artist's unread releases, not just the newest — two records in one week is
    /// exactly the case a fan most wants to see, and it was the case that got truncated.
    var newReleases: [NewRelease] = []
    let onRemove: () -> Void
    let onRefresh: () -> Void

    #if os(macOS)
    @State private var isHovering = false
    #endif

    #if os(iOS)
    private let iconButtonSize: CGFloat = 44
    private let refreshIconSize: CGFloat = 18
    private let heartIconSize: CGFloat = 20
    private let nameFont: Font = .system(size: 14, weight: .semibold)
    private let locationFont: Font = .system(size: 11)
    #else
    private let iconButtonSize: CGFloat = 14
    private let refreshIconSize: CGFloat = 12
    private let heartIconSize: CGFloat = 14
    private let nameFont: Font = .headline
    private let locationFont: Font = .caption
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                // Artist photo
                artistPhoto

                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.artistName)
                        .font(nameFont)

                    if let locationText = entry.location?.displayText {
                        Text(locationText)
                            .font(locationFont)
                            .foregroundColor(.secondary)
                    }
                }
                .textSelection(.enabled)

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
                    .accessibilityLabel("Refresh platforms for \(entry.artistName)")
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
                .accessibilityLabel("Remove \(entry.artistName) from Saved Artists")
                #if os(macOS)
                .opacity(isHovering ? 1 : 0.5)
                .help("Remove from Saved Artists")
                #endif
            }

            // New release indicators, one per unread release
            ForEach(newReleases) { release in
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
        // The refresh and remove buttons are hover-dimmed, so the context menu is the
        // non-hover path to both — required for keyboard and VoiceOver users.
        .contextMenu {
            Button("Copy Artist Name") { copyToClipboard(text: entry.artistName) }

            Divider()

            Button("Refresh Platforms", action: onRefresh)
                .disabled(isRefreshing)
            Button("Remove from Saved Artists", role: .destructive, action: onRemove)
        }
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
        BrandColor.legible(hex: platform.color, isDark: colorScheme == .dark)
    }

    #if os(iOS)
    private let socialBadgeSize: CGFloat = 44
    private let socialIconSize: CGFloat = 20
    private let badgeIconSize: CGFloat = 14
    private let badgeFont: Font = .system(size: 14, weight: .medium)
    private let badgePaddingH: CGFloat = 12
    private let badgePaddingV: CGFloat = 10
    private let badgeSpacing: CGFloat = 6
    #else
    private let socialBadgeSize: CGFloat = 28
    private let socialIconSize: CGFloat = 14
    private let badgeIconSize: CGFloat = 10
    private let badgeFont: Font = .caption.weight(.medium)
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
                        .font(badgeFont)
                }
                .padding(.horizontal, badgePaddingH)
                .padding(.vertical, badgePaddingV)
                .background(platformColor.opacity(0.15))
                .foregroundColor(platformColor)
                .cornerRadius(6)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(platform.displayName)")
        #if os(macOS)
        .help("Open \(platform.displayName)")
        #endif
        .linkActions(
            url: URL(string: platform.url),
            openTitle: "Open on \(platform.displayName)",
            onOpen: openPlatformURL
        )
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

    /// Set by the macOS popover, which drills down in place rather than opening a window.
    @Environment(\.openReleaseGuide) private var openReleaseGuide

    #if os(iOS)
    @State private var safariItem: SafariURL?
    @State private var guideTarget: ReleaseGuideTarget?
    #endif

    #if os(iOS)
    private let labelFont: Font = .system(size: 14, weight: .medium)
    private let paddingH: CGFloat = 12
    private let paddingV: CGFloat = 10
    #else
    private let labelFont: Font = .caption.weight(.medium)
    private let paddingH: CGFloat = 8
    private let paddingV: CGFloat = 4
    #endif

    var body: some View {
        Button(action: openRelease) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundColor(.yellow)
                Text("New release: \(release.releaseName)")
                    .font(labelFont)
                    .lineLimit(1)
            }
            .padding(.horizontal, paddingH)
            .padding(.vertical, paddingV)
            .background(Color.yellow.opacity(0.15))
            .foregroundColor(.primary)
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityText)
        #if os(macOS)
        .help(helpText)
        #endif
        .linkActions(
            url: URL(string: release.releaseUrl),
            // The context menu always opens the link in a browser, so it names wherever the link
            // actually goes — our release page for a catalogued release, the shop for an alert
            // from the older scrape path.
            openTitle: release.guideTarget != nil
                ? "Open on Unstream"
                : "Open on \(release.displayPlatform)",
            onOpen: openInBrowser
        )
        #if os(iOS)
        .safariSheet(safariItem: $safariItem)
        .sheet(item: $guideTarget) { ReleaseGuideSheet(target: $0) }
        #endif
    }

    /// Show the payout comparison in the app when the release is one we've catalogued; fall back
    /// to the browser only for alerts from the older scrape path, whose `releaseUrl` points at a
    /// single shop and so has no guide behind it.
    private func openRelease() {
        guard let target = release.guideTarget else {
            openInBrowser()
            return
        }
        #if os(macOS)
        guard let openReleaseGuide else {
            openInBrowser()
            return
        }
        openReleaseGuide(target)
        #else
        guideTarget = target
        #endif
    }

    private func openInBrowser() {
        guard let url = URL(string: release.releaseUrl) else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        safariItem = SafariURL(url: url)
        #endif
    }

    private var accessibilityText: String {
        release.guideTarget != nil
            ? "New release: \(release.releaseName). Show where to buy."
            : "New release: \(release.releaseName) on \(release.displayPlatform)"
    }

    private var helpText: String {
        release.guideTarget != nil
            ? "Where to buy \(release.releaseName)"
            : "Open \(release.releaseName) on \(release.displayPlatform)"
    }
}
