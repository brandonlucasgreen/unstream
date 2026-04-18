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
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .textCase(.uppercase)
            }

            if results.isEmpty {
                Text("No results found")
                    .font(.caption)
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

    #if os(iOS)
    @State private var safariItem: SafariURL?
    #endif

    private var isSaved: Bool {
        supportListManager.isArtistSaved(artist.name)
    }

    #if os(iOS)
    private let headerIconButtonSize: CGFloat = 44
    private let heartIconSize: CGFloat = 22
    private let shareIconSize: CGFloat = 20
    #else
    private let headerIconButtonSize: CGFloat = 14
    private let heartIconSize: CGFloat = 14
    private let shareIconSize: CGFloat = 13
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Artist name with photo and save button
            HStack(spacing: 10) {
                // Artist photo (conditionally shown)
                if showPhoto {
                    artistPhoto
                }

                Text(artist.name)
                    .font(.system(size: 14, weight: .semibold))

                Spacer()

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
                #if os(macOS)
                .help(isSaved ? "Remove from Saved Artists" : "Add to Saved Artists")
                #endif
            }

            // Verified platforms section
            if !artist.verifiedPlatforms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Found on \(artist.verifiedPlatforms.count) platform\(artist.verifiedPlatforms.count == 1 ? "" : "s"):")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    FlowLayout(spacing: 6) {
                        ForEach(artist.verifiedPlatforms) { platform in
                            PlatformBadge(result: platform, onOpen: {
                                appState.trackLinkClick(artist: artist, platformId: platform.sourceId)
                            })
                        }
                    }
                }
            }

            // Social platforms section
            if !artist.socialPlatforms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Social:")
                        .font(.caption)
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

            // Search-only platforms section
            if !artist.searchOnlyPlatforms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Also try:")
                        .font(.caption)
                        .foregroundColor(.secondary.opacity(0.8))

                    FlowLayout(spacing: 6) {
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
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 10))
                    Text("Report an issue with this result")
                        .font(.system(size: 11))
                }
                .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .padding(10)
        .background(cardBackgroundColor)
        .cornerRadius(8)
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
            .frame(width: 40, height: 40)
            .clipShape(Circle())
        } else {
            Image(systemName: "person.circle.fill")
                .resizable()
                .foregroundColor(.secondary.opacity(0.5))
                .frame(width: 40, height: 40)
        }
    }

    @ViewBuilder
    private var shareButton: some View {
        #if os(macOS)
        Button(action: shareArtistCard) {
            Image(systemName: "square.and.arrow.up")
                .foregroundColor(.secondary)
                .font(.system(size: shareIconSize))
                .frame(width: headerIconButtonSize, height: headerIconButtonSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Share this artist")
        #else
        let text = shareText
        ShareLink(item: text) {
            Image(systemName: "square.and.arrow.up")
                .foregroundColor(.secondary)
                .font(.system(size: shareIconSize))
                .frame(width: headerIconButtonSize, height: headerIconButtonSize)
                .contentShape(Rectangle())
        }
        #endif
    }

    // MARK: - Helpers

    private var cardBackgroundColor: Color {
        #if os(macOS)
        Color(NSColor.controlBackgroundColor)
        #else
        Color(.secondarySystemGroupedBackground)
        #endif
    }

    private var shareText: String {
        let url: String
        if let claimedSlug = artist.claimedSlug {
            url = "https://unstream.stream/a/\(claimedSlug)"
        } else if let encodedName = artist.name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            url = "https://unstream.stream/?q=\(encodedName)"
        } else {
            url = "https://unstream.stream"
        }

        if let nowPlaying = appState.nowPlaying,
           nowPlaying.artist?.lowercased() == artist.name.lowercased(),
           let title = nowPlaying.title {
            return "Listening to \"\(title)\" by \(artist.name) — here's how you can support them directly: \(url)"
        }

        return "Here's how you can support \(artist.name) directly: \(url)"
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
        // SFSafariViewController only accepts http/https, so route mailto: through UIApplication
        UIApplication.shared.open(url)
        #endif
    }

    #if os(macOS)
    private func shareArtistCard() {
        let text = shareText
        let picker = NSSharingServicePicker(items: [text])
        if let window = NSApp.keyWindow,
           let contentView = window.contentView {
            let rect = NSRect(x: contentView.bounds.midX, y: contentView.bounds.maxY - 50, width: 1, height: 1)
            picker.show(relativeTo: rect, of: contentView, preferredEdge: .minY)
        }
    }
    #endif
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
