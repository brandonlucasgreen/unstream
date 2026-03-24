import SwiftUI

/// A share card rendered as an image for social sharing.
/// Shows what the user is listening to and where to support the artist directly.
struct ShareCardView: View {
    let nowPlaying: NowPlaying
    let artistImageUrl: String?
    let platforms: [PlatformResult]

    private let cardWidth: CGFloat = 600
    private let cardHeight: CGFloat = 400
    private let bgColor = Color(red: 0.08, green: 0.08, blue: 0.1)

    var body: some View {
        ZStack {
            bgColor

            HStack(spacing: 24) {
                // Artist image
                artistImage
                    .frame(width: 140, height: 140)
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                VStack(alignment: .leading, spacing: 12) {
                    // Track info
                    VStack(alignment: .leading, spacing: 4) {
                        if let artist = nowPlaying.artist {
                            Text(artist)
                                .font(.system(size: 24, weight: .bold))
                                .foregroundColor(.white)
                                .lineLimit(2)
                        }
                        if let title = nowPlaying.title {
                            Text(title)
                                .font(.system(size: 16))
                                .foregroundColor(.white.opacity(0.7))
                                .lineLimit(1)
                        }
                        if let album = nowPlaying.album {
                            Text(album)
                                .font(.system(size: 14))
                                .foregroundColor(.white.opacity(0.5))
                                .lineLimit(1)
                        }
                    }

                    // Platforms
                    if !platforms.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Support directly:")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.white.opacity(0.4))
                                .textCase(.uppercase)

                            ForEach(platforms.prefix(3)) { platform in
                                HStack(spacing: 8) {
                                    Circle()
                                        .fill(Color(hex: platform.color) ?? .blue)
                                        .frame(width: 8, height: 8)
                                    Text(platform.displayName)
                                        .font(.system(size: 14, weight: .medium))
                                        .foregroundColor(.white)
                                    Spacer()
                                    if let payout = platform.artistPayoutPercent {
                                        Text(payout)
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundColor(.white.opacity(0.6))
                                    }
                                }
                            }
                        }
                    }

                    Spacer()

                    // Branding
                    Text("unstream.stream")
                        .font(.system(size: 12))
                        .foregroundColor(.white.opacity(0.3))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(32)
        }
        .frame(width: cardWidth, height: cardHeight)
    }

    @ViewBuilder
    private var artistImage: some View {
        if let imageUrl = artistImageUrl, let url = URL(string: imageUrl) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                case .failure:
                    imagePlaceholder
                case .empty:
                    imagePlaceholder
                @unknown default:
                    imagePlaceholder
                }
            }
        } else {
            imagePlaceholder
        }
    }

    private var imagePlaceholder: some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(Color.white.opacity(0.1))
            .overlay(
                Image(systemName: "music.note")
                    .font(.system(size: 40))
                    .foregroundColor(.white.opacity(0.3))
            )
    }
}

// MARK: - Image rendering

extension ShareCardView {
    /// Render the card as an NSImage at 2x scale for retina quality.
    @MainActor
    func renderAsImage() -> NSImage? {
        let renderer = ImageRenderer(content: self)
        renderer.scale = 2.0
        return renderer.nsImage
    }
}

#Preview {
    ShareCardView(
        nowPlaying: NowPlaying(
            title: "Paranoid Android",
            artist: "Radiohead",
            album: "OK Computer",
            artworkData: nil
        ),
        artistImageUrl: nil,
        platforms: [
            PlatformResult(sourceId: "bandcamp", url: "https://radiohead.bandcamp.com", latestRelease: nil),
            PlatformResult(sourceId: "mirlo", url: nil, latestRelease: nil),
            PlatformResult(sourceId: "faircamp", url: nil, latestRelease: nil),
        ]
    )
}
