import Foundation

struct NowPlaying: Equatable {
    let title: String?
    let artist: String?
    let album: String?
    let artworkData: Data?
    let durationSeconds: Double?
    let source: PlaybackSource?

    var hasContent: Bool {
        artist != nil || title != nil
    }

    /// Unique identifier for this track (used to detect track changes)
    var trackId: String {
        "\(artist ?? "")-\(title ?? "")-\(album ?? "")"
    }

    /// Convenience initializer with default values for new fields
    init(title: String?, artist: String?, album: String?, artworkData: Data?, durationSeconds: Double? = nil, source: PlaybackSource? = nil) {
        self.title = title
        self.artist = artist
        self.album = album
        self.artworkData = artworkData
        self.durationSeconds = durationSeconds
        self.source = source
    }
}

enum PlaybackSource: String, Equatable {
    case appleMusic = "Apple Music"
    case spotify = "Spotify"
}
