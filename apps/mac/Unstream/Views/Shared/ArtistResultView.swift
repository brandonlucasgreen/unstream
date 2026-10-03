import SwiftUI

#if os(macOS)
import AppKit
#endif

struct ResultsView: View {
    let title: String?
    let results: [ArtistResult]
    var showArtistPhoto: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title = title {
                Text(title)
                    .font(.smallText)
                    .foregroundColor(.secondary)
                    .textCase(.uppercase)
            }

            if results.isEmpty {
                Text("No results found")
                    .font(.smallText)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 8)
            } else {
                ForEach(results) { artist in
                    ArtistResultView(artist: artist, showPhoto: showArtistPhoto)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ArtistResultView: View {
    let artist: ArtistResult
    var showPhoto: Bool = true
    @EnvironmentObject var supportListManager: SupportListManager
    @EnvironmentObject var appState: AppState

    #if os(macOS)
    /// Set by the popover, which drills down in place rather than opening a window.
    @Environment(\.openArtistReleases) private var openArtistReleases
    #endif

    #if os(iOS)
    @State private var safariItem: SafariURL?
    @State private var releaseTarget: ReleaseGuideTarget?
    #endif

    private var isSaved: Bool {
        supportListManager.isArtistSaved(artist.name)
    }

    #if os(iOS)
    private let headerIconButtonSize: CGFloat = 44
    private let heartIconSize: CGFloat = 22
    private let shareIconSize: CGFloat = 20
    // iOS keeps its explicit sizes; macOS uses semantic styles so text follows the
    // system text-size setting.
    private let nameFont: Font = .system(size: 14, weight: .semibold)
    private let locationFont: Font = .system(size: 11)
    private let reportFont: Font = .system(size: 11)
    private let photoSize: CGFloat = 40
    private let cardPadding: CGFloat = 10
    private let cardCornerRadius: CGFloat = 8
    private let sectionSpacing: CGFloat = 10
    private let badgeSpacing: CGFloat = 6
    private let releasesRowFont: Font = .caption.weight(.medium)
    private let headerButtonSpacing: CGFloat = 10
    private let headerSpacerMinLength: CGFloat? = nil
    private let bioLineLimit = 3
    #else
    // A 28-point hit area around each header glyph; at 14 the heart and share were easy to miss.
    private let headerIconButtonSize: CGFloat = 28
    private let heartIconSize: CGFloat = 15
    private let shareIconSize: CGFloat = 14
    private let nameFont: Font = .title3.weight(.semibold)
    private let locationFont: Font = .callout
    private let reportFont: Font = .subheadline
    private let photoSize: CGFloat = 44
    private let cardPadding: CGFloat = 14
    private let cardCornerRadius: CGFloat = 12
    private let sectionSpacing: CGFloat = 12
    private let badgeSpacing: CGFloat = 8
    private let releasesRowFont: Font = .body.weight(.medium)
    // The two 28-point hit areas sit flush — their glyphs still read as separate — so the name
    // and location keep enough width for "Massachusetts, United States" on one line.
    private let headerButtonSpacing: CGFloat = 0
    private let headerSpacerMinLength: CGFloat? = 0
    // The menu-bar popover is the tightest space the app has.
    private let bioLineLimit = 2
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: sectionSpacing) {
            // Artist name with photo and save button
            HStack(spacing: 10) {
                // Artist photo (conditionally shown)
                if showPhoto {
                    artistPhoto
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(artist.name)
                        .font(nameFont)

                    if let locationText = artist.location?.displayText {
                        Text(locationText)
                            .font(locationFont)
                            .foregroundColor(.secondary)
                    }
                }
                .textSelection(.enabled)

                Spacer(minLength: headerSpacerMinLength)

                HStack(spacing: headerButtonSpacing) {
                    // Share button
                    if !artist.verifiedPlatforms.isEmpty {
                        shareButton
                    }

                    Button(action: { supportListManager.toggleArtist(artist) }) {
                        Image(systemName: isSaved ? "heart.fill" : "heart")
                            .foregroundColor(isSaved ? .red : .secondary)
                            .font(.system(size: heartIconSize))
                            .frame(width: headerIconButtonSize, height: headerIconButtonSize)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isSaved ? "Remove \(artist.name) from Saved Artists" : "Add \(artist.name) to Saved Artists")
                    #if os(macOS)
                    .help(isSaved ? "Remove from Saved Artists" : "Add to Saved Artists")
                    #endif
                }
            }

            if let bio = artist.bio {
                ArtistBioView(bio: bio, collapsedLineLimit: bioLineLimit, onOpenSource: openBioSource)
            }

            // Tip, for an artist taking tips on Unstream: before every platform badge, since it's the
            // most direct support a fan can give (Brandon, 2026-10-03). macOS only: no patronage
            // surface ships on iOS (artist-patronage-spec.md §7).
            #if os(macOS)
            if artist.tipsEnabled == true, let slug = artist.pageSlug {
                ArtistTipButton(slug: slug, artistName: artist.name)
            }
            #endif

            // Verified platforms section
            if !artist.verifiedPlatforms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Found on \(artist.verifiedPlatforms.count) platform\(artist.verifiedPlatforms.count == 1 ? "" : "s"):")
                        .font(.smallText)
                        .foregroundColor(.secondary)

                    FlowLayout(spacing: badgeSpacing) {
                        ForEach(artist.verifiedPlatforms) { platform in
                            PlatformBadge(result: platform, onOpen: {
                                appState.trackLinkClick(artist: artist, platformId: platform.sourceId)
                            })
                        }
                    }
                }
            }

            // The way from "I found them" to "here's what their records cost".
            //
            // Only shown when the search placed the artist — `pageSlug` is nil for an unverified
            // result, which nothing persists, so there would be no page behind the row.
            if let slug = artist.pageSlug {
                releasesRow(slug: slug)
            }

            // Social platforms section
            if !artist.socialPlatforms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Social:")
                        .font(.smallText)
                        .foregroundColor(.secondary)

                    HStack(spacing: 8) {
                        ForEach(artist.socialPlatforms) { platform in
                            SocialIconButton(result: platform, onOpen: {
                                appState.trackLinkClick(artist: artist, platformId: platform.sourceId)
                            })
                        }
                    }
                }
            }

            // A result with no links at all — a claimed profile whose owner hasn't added
            // any yet will do this. Without something here the card is just a name and a
            // "report an issue" link, which reads as broken.
            if artist.platforms.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "link.slash")
                        .foregroundColor(.secondary)
                        .accessibilityHidden(true)
                    Text("No links listed yet.")
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .font(locationFont)
            }

            // Search-only platforms section
            if !artist.searchOnlyPlatforms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Also try:")
                        .font(.smallText)
                        .foregroundColor(.secondary.opacity(0.8))

                    FlowLayout(spacing: badgeSpacing) {
                        ForEach(artist.searchOnlyPlatforms) { platform in
                            PlatformBadge(result: platform, isSubtle: true, onOpen: {
                                appState.trackLinkClick(artist: artist, platformId: platform.sourceId)
                            })
                        }
                    }
                }
            }



            // Report issue link
            Button(action: { reportIssue(artist: artist) }) {
                Label("Report an issue with this result", systemImage: "exclamationmark.triangle")
                    .font(reportFont)
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .center)
            .accessibilityLabel("Report an issue with the result for \(artist.name)")
        }
        .padding(cardPadding)
        .background(cardBackgroundColor)
        .cornerRadius(cardCornerRadius)
        .draggable(artistURL)
        .contextMenu {
            Button(isSaved ? "Remove from Saved Artists" : "Save Artist") {
                supportListManager.toggleArtist(artist)
            }

            Divider()

            Button("Copy Artist Name") { copyToClipboard(text: artist.name) }
            Button("Copy Unstream Link") { copyToClipboard(url: artistURL) }
            ShareLink(item: artistURL, message: Text(shareMessage))

            Divider()

            Button("Report an Issue…") { reportIssue(artist: artist) }
        }
        #if os(iOS)
        .safariSheet(safariItem: $safariItem)
        #endif
    }

    // MARK: - Subviews

    @ViewBuilder
    private var artistPhoto: some View {
        if let imageUrl = artist.imageUrl, let url = URL(string: imageUrl) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                case .failure(_):
                    Image(systemName: "person.circle.fill")
                        .resizable()
                        .foregroundColor(.secondary.opacity(0.5))
                case .empty:
                    ProgressView()
                        .scaleEffect(0.5)
                @unknown default:
                    Image(systemName: "person.circle.fill")
                        .resizable()
                        .foregroundColor(.secondary.opacity(0.5))
                }
            }
            .frame(width: photoSize, height: photoSize)
            .clipShape(Circle())
        } else {
            Image(systemName: "person.circle.fill")
                .resizable()
                .foregroundColor(.secondary.opacity(0.5))
                .frame(width: photoSize, height: photoSize)
        }
    }

    /// `ShareLink` with a real `URL` rather than a string containing one, so link-aware
    /// targets (Messages previews, Reading List, Notes) can do something with it. This
    /// also replaces a hand-anchored `NSSharingServicePicker` that positioned itself off
    /// `NSApp.keyWindow`, which is the wrong window when the popover is showing.
    private var shareButton: some View {
        ShareLink(item: artistURL, message: Text(shareMessage)) {
            Image(systemName: "square.and.arrow.up")
                .foregroundColor(.secondary)
                .font(.system(size: shareIconSize))
                .frame(width: headerIconButtonSize, height: headerIconButtonSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Share \(artist.name)")
        #if os(macOS)
        .help("Share this artist")
        #endif
    }

    // MARK: - Releases

    /// macOS drills into the popover in place; iOS pushes onto the search tab's existing
    /// NavigationStack. Both land on the same `ArtistReleasesView`.
    @ViewBuilder
    private func releasesRow(slug: String) -> some View {
        #if os(macOS)
        Button { openArtistReleases?(slug, artist.name) } label: { releasesRowLabel }
            .buttonStyle(.plain)
            .help("See \(artist.name)'s releases and prices")
        #else
        NavigationLink {
            ArtistReleasesView(slug: slug, fallbackName: artist.name) { target in
                releaseTarget = target
            }
            .navigationTitle("Releases")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $releaseTarget) { target in
                ReleaseGuideView(target: target)
                    .navigationTitle("Where to Buy")
                    .navigationBarTitleDisplayMode(.inline)
            }
        } label: {
            releasesRowLabel
        }
        .buttonStyle(.plain)
        #endif
    }

    private var releasesRowLabel: some View {
        HStack(spacing: 8) {
            Image(systemName: "music.note.list")
                .foregroundColor(.accentColor)
            Text("Releases & prices")
                .font(releasesRowFont)
                .foregroundColor(.primary)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.smallerText)
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.10)))
        .accessibilityLabel("See \(artist.name)'s releases and prices")
    }

    // MARK: - Helpers

    private var cardBackgroundColor: Color {
        #if os(macOS)
        Color(NSColor.controlBackgroundColor)
        #else
        Color(.secondarySystemGroupedBackground)
        #endif
    }

    /// Canonical Unstream link for this artist — the claimed profile when there is one,
    /// otherwise a search permalink.
    private var artistURL: URL {
        if let claimedSlug = artist.claimedSlug,
           let url = URL(string: "https://unstream.stream/a/\(claimedSlug)") {
            return url
        }
        if let encodedName = artist.name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let url = URL(string: "https://unstream.stream/?q=\(encodedName)") {
            return url
        }
        return URL(string: "https://unstream.stream")!
    }

    /// Prose that accompanies the link when the share target accepts text.
    private var shareMessage: String {
        if let nowPlaying = appState.nowPlaying,
           nowPlaying.artist?.lowercased() == artist.name.lowercased(),
           let title = nowPlaying.title {
            return "Listening to \"\(title)\" by \(artist.name) — here's how you can support them directly:"
        }
        return "Here's how you can support \(artist.name) directly:"
    }

    private func openBioSource(_ url: URL) {
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        safariItem = SafariURL(url: url)
        #endif
    }

    private func reportIssue(artist: ArtistResult) {
        let platformList = artist.platforms.map { "- \($0.sourceId): \($0.url ?? "N/A")" }.joined(separator: "\n")
        let subject = "Issue Report: \(artist.name)"
        let body = """
        Artist/Result: \(artist.name)
        Type: \(artist.type)

        Platforms:
        \(platformList)

        Issue Description:
        [Please describe what's wrong with this result]
        """

        guard let encodedSubject = subject.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let encodedBody = body.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "mailto:support@unstream.stream?subject=\(encodedSubject)&body=\(encodedBody)") else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        // SFSafariViewController crashes on non-http(s) URLs; hand mailto off to the system.
        UIApplication.shared.open(url)
        #endif
    }

}

/// The artist's bio, clamped to a few lines with an inline "More", and a link to where it came
/// from unless that's the artist's own Unstream page. Nothing opens until the reader asks.
private struct ArtistBioView: View {
    let bio: ArtistBio
    let collapsedLineLimit: Int
    let onOpenSource: (URL) -> Void

    @State private var isExpanded = false
    @State private var fullHeight: CGFloat = 0
    @State private var clampedHeight: CGFloat = 0

    /// "More" only when the clamp is actually hiding something. Measured rather than guessed
    /// from a character count, which would be wrong at every other width and text size.
    private var isClamped: Bool { fullHeight > clampedHeight + 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(bio.text)
                .font(.smallText)
                .foregroundColor(.primary.opacity(0.85))
                .lineLimit(isExpanded ? nil : collapsedLineLimit)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .background(heightReader { clampedHeight = $0 })
                .background(
                    // The same text unclamped, invisible, to learn how tall it would be.
                    Text(bio.text)
                        .font(.smallText)
                        .fixedSize(horizontal: false, vertical: true)
                        .hidden()
                        .background(heightReader { fullHeight = $0 })
                        .accessibilityHidden(true)
                )

            if showsToggle || sourceLink != nil {
                HStack(spacing: 10) {
                    if showsToggle {
                        Button(isExpanded ? "Less" : "More") { isExpanded.toggle() }
                            .buttonStyle(.plain)
                            .foregroundColor(.accentColor)
                            .accessibilityLabel(isExpanded ? "Show less of the bio" : "Show the whole bio")
                    }
                    if let link = sourceLink {
                        Button { onOpenSource(link.url) } label: {
                            Label(bio.truncated ? "\(link.label) · Read more" : link.label, systemImage: "arrow.up.right")
                                .labelStyle(TrailingIconLabelStyle())
                        }
                        .buttonStyle(.plain)
                        .foregroundColor(.secondary)
                        .linkActions(url: link.url, openTitle: "Open Bio Source", onOpen: { onOpenSource(link.url) })
                        #if os(macOS)
                        .help(bio.sourceUrl)
                        #endif
                    }
                }
                .font(.smallerText)
            }
        }
    }

    private var showsToggle: Bool { isClamped || isExpanded }

    /// Nil when there's no source line to draw: a claimed artist's own bio, or an unusable URL.
    private var sourceLink: (label: String, url: URL)? {
        guard let label = bio.sourceLabel, let url = URL(string: bio.sourceUrl) else { return nil }
        return (label, url)
    }

    private func heightReader(_ update: @escaping (CGFloat) -> Void) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { update(proxy.size.height) }
                .onChange(of: proxy.size.height) { height in update(height) }
        }
    }
}

/// "From Bandcamp ↗" — the arrow after the words, as a link-out reads.
private struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 2) {
            configuration.title
            configuration.icon.imageScale(.small)
        }
    }
}

// Simple flow layout for platform badges
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = layout(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = layout(proposal: proposal, subviews: subviews)

        for (index, subview) in subviews.enumerated() {
            subview.place(at: CGPoint(x: bounds.minX + result.positions[index].x,
                                       y: bounds.minY + result.positions[index].y),
                          proposal: .unspecified)
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var currentX: CGFloat = 0
        var currentY: CGFloat = 0
        var lineHeight: CGFloat = 0
        var totalHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)

            if currentX + size.width > maxWidth && currentX > 0 {
                currentX = 0
                currentY += lineHeight + spacing
                lineHeight = 0
            }

            positions.append(CGPoint(x: currentX, y: currentY))
            currentX += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            totalHeight = currentY + lineHeight
        }

        return (CGSize(width: maxWidth, height: totalHeight), positions)
    }
}
