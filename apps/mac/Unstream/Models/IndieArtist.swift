import Foundation

struct IndieArtist: Codable, Identifiable, Equatable {
    let slug: String
    let name: String
    let imageUrl: String?

    var id: String { slug }
}
