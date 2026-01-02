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

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Artist name
            Text(artist.name)
                .font(.system(size: 14, weight: .semibold))

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

            // Open in Unstream button
            Button(action: { openInUnstream(artist: artist.name) }) {
                HStack {
                    Image(systemName: "arrow.up.right.square")
                    Text("Open in Unstream")
                }
                .font(.caption)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
        .padding(10)
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(8)
    }

    private func openInUnstream(artist: String) {
        guard let encodedQuery = artist.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "https://unstream.stream/?search=\(encodedQuery)") else {
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
    .padding()
    .frame(width: 300)
}
