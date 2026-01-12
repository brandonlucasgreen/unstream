import SwiftUI

struct ResultsView: View {
    let title: String?
    let results: [ArtistResult]

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
                    ArtistResultView(artist: artist)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ArtistResultView: View {
    let artist: ArtistResult
    @EnvironmentObject var licenseManager: LicenseManager
    @EnvironmentObject var supportListManager: SupportListManager

    private var isSaved: Bool {
        supportListManager.isArtistSaved(artist.name)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Artist name with save button
            HStack {
                Text(artist.name)
                    .font(.system(size: 14, weight: .semibold))

                Spacer()

                if licenseManager.isPro {
                    Button(action: { supportListManager.toggleArtist(artist) }) {
                        Image(systemName: isSaved ? "heart.fill" : "heart")
                            .foregroundColor(isSaved ? .red : .secondary)
                            .font(.system(size: 14))
                    }
                    .buttonStyle(.plain)
                    .help(isSaved ? "Remove from Saved Artists" : "Add to Saved Artists")
                }
            }

            // Verified platforms section
            if !artist.verifiedPlatforms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Found on \(artist.verifiedPlatforms.count) platform\(artist.verifiedPlatforms.count == 1 ? "" : "s"):")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    FlowLayout(spacing: 6) {
                        ForEach(artist.verifiedPlatforms) { platform in
                            PlatformBadge(result: platform)
                        }
                    }
                }
            }

            // Social platforms section (show before "Also try")
            if !artist.socialPlatforms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Social:")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    HStack(spacing: 8) {
                        ForEach(artist.socialPlatforms) { platform in
                            SocialIconButton(result: platform)
                        }
                    }
                }
            }

            // Search-only platforms section
            if !artist.searchOnlyPlatforms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 4) {
                        Text("Also try:")
                            .font(.caption)
                            .foregroundColor(.secondary.opacity(0.8))
                    }

                    FlowLayout(spacing: 6) {
                        ForEach(artist.searchOnlyPlatforms) { platform in
                            PlatformBadge(result: platform, isSubtle: true)
                        }
                    }
                }
            }

            // Open in browser button
            Button(action: { openInUnstream(artist: artist.name) }) {
                HStack {
                    Image(systemName: "arrow.up.right.square")
                    Text("Open in browser")
                }
                .font(.caption)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)

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
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(8)
    }

    private func openInUnstream(artist: String) {
        guard let encodedQuery = artist.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "https://unstream.stream/?q=\(encodedQuery)") else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    private func reportIssue(artist: ArtistResult) {
        let platformList = artist.platforms.map { platform in
            "- \(platform.sourceId): \(platform.url ?? "N/A")"
        }.joined(separator: "\n")

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
              let url = URL(string: "mailto:support@unstream.stream?subject=\(encodedSubject)&body=\(encodedBody)") else {
            return
        }
        NSWorkspace.shared.open(url)
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

#Preview {
    ResultsView(
        title: "Search Results",
        results: [
            ArtistResult(
                id: "radiohead",
                name: "Radiohead",
                type: "artist",
                imageUrl: nil,
                platforms: [
                    PlatformResult(sourceId: "bandcamp", url: "https://radiohead.bandcamp.com", latestRelease: nil),
                    PlatformResult(sourceId: "qobuz", url: nil, latestRelease: nil),
                    PlatformResult(sourceId: "ampwall", url: nil, latestRelease: nil),
                    PlatformResult(sourceId: "kofi", url: nil, latestRelease: nil),
                ]
            )
        ]
    )
    .environmentObject(LicenseManager())
    .environmentObject(SupportListManager())
    .padding()
    .frame(width: 300)
}
