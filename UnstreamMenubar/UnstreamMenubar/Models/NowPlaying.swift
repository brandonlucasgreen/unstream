import Foundation

struct NowPlaying: Equatable {
    let title: String?
    let artist: String?
    let album: String?
    let artworkData: Data?

    var hasContent: Bool {
        artist != nil || title != nil
    }
}
