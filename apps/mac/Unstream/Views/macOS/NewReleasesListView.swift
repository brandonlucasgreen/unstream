#if os(macOS)
import SwiftUI
import AppKit

/// Every unread release, in one place, on the Mac.
///
/// iOS has had a Releases tab since the catalog work; macOS had a per-artist badge that showed
/// one release per artist and a debug-only count in Settings — and a signed-in user, who sees
/// the synced-artists list rather than the local one, had no release surface at all. The
/// flagship client was the weaker one.
///
/// This is deliberately a drill-down rather than a third tab: it is additive, it reuses the
/// popover's existing back header, Escape and ⌘[ handling, and it doesn't ask the app's
/// top-level navigation to change shape. Whether Releases eventually earns a permanent tab
/// alongside Search and Saved is a product call, not a bug fix.
struct NewReleasesListView: View {
    @ObservedObject var releaseAlertManager: ReleaseAlertManager

    /// The popover pushes the buying guide onto its own stack rather than opening a window.
    let openGuide: (ReleaseGuideTarget) -> Void

    var body: some View {
        ScrollView {
            if releaseAlertManager.newReleases.isEmpty {
                // Reachable by dismissing the last release while looking at the list. Popping
                // the user back out from under their own click would be worse than saying so.
                VStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .font(.title2)
                        .foregroundColor(.secondary)
                    Text("No new releases")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("We check your saved artists weekly.")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.7))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            } else {
                VStack(spacing: 8) {
                    ForEach(releaseAlertManager.newReleases) { release in
                        NewReleaseRow(
                            release: release,
                            openGuide: openGuide,
                            onDismiss: { releaseAlertManager.dismissRelease(release) }
                        )
                    }
                }
                .padding(12)
            }
        }
    }
}

private struct NewReleaseRow: View {
    let release: NewRelease
    let openGuide: (ReleaseGuideTarget) -> Void
    let onDismiss: () -> Void

    @State private var isHovering = false

    private var url: URL? { URL(string: release.releaseUrl) }

    /// "Where to Buy" for a catalogued release, whose link is our own page; the shop's name for
    /// an alert from the older scrape path, because that is genuinely where the link goes.
    private var openTitle: String {
        release.guideTarget != nil ? "Open on Unstream" : "Open on \(release.displayPlatform)"
    }

    var body: some View {
        HStack(spacing: 8) {
            Button(action: open) {
                HStack(spacing: 8) {
                    Image(systemName: release.isUpcoming ? "calendar" : "sparkles")
                        .foregroundColor(.yellow)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(release.artistName)
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                        Text(release.releaseName)
                            .font(.caption)
                            .lineLimit(1)
                        // The price is the reason to click, so it leads once we have one.
                        Text(secondaryLine)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 0)

                    Image(systemName: release.guideTarget != nil ? "chevron.right" : "arrow.up.right")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityText)
            .help(helpText)

            Button(action: onDismiss) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundColor(.secondary)
                    .font(.caption)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(isHovering ? 1 : 0.3)
            .accessibilityLabel("Dismiss \(release.releaseName)")
            .help("Dismiss")
        }
        .padding(10)
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(8)
        .onHover { isHovering = $0 }
        // Draggable and copyable like every other link in the app — a release is a thing a Mac
        // user drags into a note or a message. Not `linkActions`, because this menu also has to
        // carry Dismiss: the ✕ is hover-dimmed, so the context menu is the keyboard and
        // VoiceOver path to it.
        .draggableLink(url)
        .contextMenu {
            if release.guideTarget != nil {
                Button("Where to Buy", action: open)
            }
            if let url {
                Button(openTitle) { NSWorkspace.shared.open(url) }
                Divider()
                Button("Copy Link") { copyToClipboard(url: url) }
                ShareLink(item: url)
            }
            Divider()
            Button("Dismiss", action: onDismiss)
        }
    }

    /// One line, so it carries the single most useful fact: when an announced record lands, or
    /// what a released one costs. Falls back to the platform rather than inventing either.
    private var secondaryLine: String {
        if release.isUpcoming { return "Announced for \(release.displayDate)" }
        if !release.offerSummary.isEmpty { return release.offerSummary }
        return "On \(release.displayPlatform)"
    }

    private var accessibilityText: String {
        release.guideTarget != nil
            ? "\(release.releaseName) by \(release.artistName). Show where to buy."
            : "\(release.releaseName) by \(release.artistName) on \(release.displayPlatform)"
    }

    private var helpText: String {
        release.guideTarget != nil
            ? "Where to buy \(release.releaseName)"
            : "Open \(release.releaseName) on \(release.displayPlatform)"
    }

    /// The payout comparison in the app for a catalogued release; the browser only for an alert
    /// from the older scrape path, which has no guide behind it.
    private func open() {
        if let target = release.guideTarget {
            openGuide(target)
        } else if let url {
            NSWorkspace.shared.open(url)
        }
    }
}

private extension View {
    /// `.draggable` needs a non-optional payload; a release with an unparseable URL simply
    /// isn't draggable rather than dragging something empty.
    @ViewBuilder
    func draggableLink(_ url: URL?) -> some View {
        if let url { self.draggable(url) } else { self }
    }
}
#endif
