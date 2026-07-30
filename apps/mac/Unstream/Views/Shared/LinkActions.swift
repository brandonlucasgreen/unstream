import SwiftUI

/// Adds the affordances a Mac user expects on anything that opens a URL: drag it out to
/// Safari/Notes/Finder, and right-click to open, copy, or share it.
///
/// Applied as a modifier so views whose URL is `nil` (search-only platform entries with
/// no target yet) opt out cleanly instead of offering a menu of dead commands.
struct LinkActions: ViewModifier {
    let url: URL?
    let openTitle: String
    let onOpen: () -> Void

    func body(content: Content) -> some View {
        if let url {
            content
                .draggable(url)
                .contextMenu {
                    Button(openTitle) { onOpen() }
                    Divider()
                    Button("Copy Link") { copyToClipboard(url: url) }
                    ShareLink(item: url)
                }
        } else {
            content
        }
    }
}

extension View {
    /// - Parameters:
    ///   - url: The link target. `nil` disables all of it.
    ///   - openTitle: Menu title for the open command, e.g. "Open on Bandcamp".
    ///   - onOpen: Runs the app's own open path so click-tracking still fires.
    func linkActions(url: URL?, openTitle: String, onOpen: @escaping () -> Void) -> some View {
        modifier(LinkActions(url: url, openTitle: openTitle, onOpen: onOpen))
    }
}
