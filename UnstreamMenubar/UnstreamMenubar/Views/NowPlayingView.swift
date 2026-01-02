import SwiftUI

struct NowPlayingView: View {
    let nowPlaying: NowPlaying

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("NOW PLAYING")
                .font(.caption)
                .foregroundColor(.secondary)
                .textCase(.uppercase)

            HStack(spacing: 12) {
                // Album artwork
                if let artworkData = nowPlaying.artworkData,
                   let nsImage = NSImage(data: artworkData) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 50, height: 50)
                        .cornerRadius(6)
                } else {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.gray.opacity(0.2))
                        .frame(width: 50, height: 50)
                        .overlay(
                            Image(systemName: "music.note")
                                .foregroundColor(.secondary)
                        )
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
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
