#if os(macOS)
import SwiftUI

struct NowPlayingView: View {
    let nowPlaying: NowPlaying
    var artistImageUrl: String? = nil

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
                            .font(.callout)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    if let album = nowPlaying.album {
                        Text(album)
                            .font(.caption)
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
