#if os(macOS)
import SwiftUI

struct NowPlayingView: View {
    let nowPlaying: NowPlaying
    var artistImageUrl: String? = nil

    private let artworkSize: CGFloat = 56

    private var fallbackImage: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color.gray.opacity(0.2))
            .frame(width: artworkSize, height: artworkSize)
            .overlay(
                Image(systemName: "music.note")
                    .foregroundColor(.secondary)
            )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Title case, like a Mac sidebar section header, rather than tiny capitals.
            Text("Now Playing")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.secondary)

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
                                .frame(width: artworkSize, height: artworkSize)
                        @unknown default:
                            fallbackImage
                        }
                    }
                    .frame(width: artworkSize, height: artworkSize)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                } else if let artworkData = nowPlaying.artworkData,
                   let nsImage = NSImage(data: artworkData) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: artworkSize, height: artworkSize)
                        .cornerRadius(8)
                } else {
                    fallbackImage
                }

                // Track info. Selectable so the artist/track can be copied — Mac users
                // expect to be able to lift text out of what they're looking at.
                VStack(alignment: .leading, spacing: 2) {
                    if let artist = nowPlaying.artist {
                        Text(artist)
                            .font(.headline)
                            .lineLimit(1)
                    }
                    if let title = nowPlaying.title {
                        Text(title)
                            .font(.body)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    if let album = nowPlaying.album {
                        Text(album)
                            .font(.subheadline)
                            .foregroundColor(.secondary.opacity(0.7))
                            .lineLimit(1)
                    }
                }
                .textSelection(.enabled)

                Spacer()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            if let artist = nowPlaying.artist {
                Button("Copy Artist Name") { copyToClipboard(text: artist) }
            }
            if let title = nowPlaying.title, let artist = nowPlaying.artist {
                Button("Copy Track") { copyToClipboard(text: "\(artist) — \(title)") }
            }
        }
    }
}

#Preview {
    NowPlayingView(nowPlaying: NowPlaying(
        title: "Paranoid Android",
        artist: "Radiohead",
        album: "OK Computer",
        artworkData: nil
    ))
    .padding()
    .frame(width: 300)
}
#endif
