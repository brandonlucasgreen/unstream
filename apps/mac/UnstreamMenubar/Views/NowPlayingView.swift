import SwiftUI

struct NowPlayingView: View {
    let nowPlaying: NowPlaying
    var artistImageUrl: String? = nil
    var platforms: [PlatformResult] = []

    private var fallbackImage: some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(Color.gray.opacity(0.2))
            .frame(width: 50, height: 50)
            .overlay(
                Image(systemName: "music.note")
                    .foregroundColor(.secondary)
            )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("NOW PLAYING")
                .font(.caption)
                .foregroundColor(.secondary)
                .textCase(.uppercase)

            HStack(spacing: 12) {
                // Artist photo (or fallback to album artwork if available, then placeholder)
                if let imageUrl = artistImageUrl, let url = URL(string: imageUrl) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        case .failure(_):
                            fallbackImage
                        case .empty:
                            ProgressView()
                                .scaleEffect(0.6)
                                .frame(width: 50, height: 50)
                        @unknown default:
                            fallbackImage
                        }
                    }
                    .frame(width: 50, height: 50)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                } else if let artworkData = nowPlaying.artworkData,
                   let nsImage = NSImage(data: artworkData) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 50, height: 50)
                        .cornerRadius(6)
                } else {
                    fallbackImage
                }

                // Track info
                VStack(alignment: .leading, spacing: 2) {
                    if let artist = nowPlaying.artist {
                        Text(artist)
                            .font(.system(size: 14, weight: .semibold))
                            .lineLimit(1)
                    }
                    if let title = nowPlaying.title {
                        Text(title)
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    if let album = nowPlaying.album {
                        Text(album)
                            .font(.system(size: 11))
                            .foregroundColor(.secondary.opacity(0.7))
                            .lineLimit(1)
                    }
                }

                Spacer()

                // Share button (only shown when platforms are available)
                if !platforms.isEmpty {
                    Button(action: shareCard) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 14))
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Share what you're listening to")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func shareCard() {
        let cardView = ShareCardView(
            nowPlaying: nowPlaying,
            artistImageUrl: artistImageUrl,
            platforms: platforms
        )

        guard let image = cardView.renderAsImage() else { return }

        // Copy to clipboard
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.writeObjects([image])

        // Show share sheet
        let picker = NSSharingServicePicker(items: [image])
        if let window = NSApp.keyWindow,
           let contentView = window.contentView {
            let rect = NSRect(x: contentView.bounds.midX, y: contentView.bounds.maxY - 50, width: 1, height: 1)
            picker.show(relativeTo: rect, of: contentView, preferredEdge: .minY)
        }
    }
}

#Preview {
    NowPlayingView(
        nowPlaying: NowPlaying(
            title: "Paranoid Android",
            artist: "Radiohead",
            album: "OK Computer",
            artworkData: nil
        ),
        platforms: [
            PlatformResult(sourceId: "bandcamp", url: "https://radiohead.bandcamp.com", latestRelease: nil),
            PlatformResult(sourceId: "mirlo", url: nil, latestRelease: nil),
        ]
    )
    .padding()
    .frame(width: 300)
}
