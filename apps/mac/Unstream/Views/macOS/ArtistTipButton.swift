import SwiftUI
import AppKit

/// Tip on a result row (docs/specs/artist-patronage-spec.md §3.1, §7), shown only for an artist
/// taking tips. Opens the web tip page — hosted Stripe Checkout on the artist's own account — in
/// the browser; the app never handles a payment itself.
///
/// macOS only: the spec keeps every patronage surface off iOS (App Review 3.2.1(vii)).
struct ArtistTipButton: View {
    let slug: String
    let artistName: String

    var body: some View {
        Button(action: openTipPage) {
            Label("Tip \(artistName)", systemImage: "heart.fill")
                .lineLimit(1)
        }
        // Filled, like the web's Tip button: the most prominent action on the row.
        .buttonStyle(.borderedProminent)
        .help("Tip \(artistName) in your browser. The payment goes straight to their Stripe account.")
    }

    private func openTipPage() {
        let path = slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slug
        guard let url = URL(string: "https://unstream.stream/tip/\(path)") else { return }
        NSWorkspace.shared.open(url)
    }
}
