import UIKit
import UniformTypeIdentifiers

class ShareViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()

        // Make extension invisible — we have no UI, just process and close
        view.isHidden = true

        // Process shared items immediately
        handleSharedItems()
    }

    private func handleSharedItems() {
        guard let extensionItems = extensionContext?.inputItems as? [NSExtensionItem] else {
            close()
            return
        }

        // Collect the share text (often contains artist name) and URL
        var sharedURL: URL?
        var sharedText: String?

        for item in extensionItems {
            // The attributedContentText often contains "Song by Artist" or similar
            if let text = item.attributedContentText?.string, !text.isEmpty {
                sharedText = text
            }

            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, error in
                        DispatchQueue.main.async {
                            if let url = item as? URL {
                                sharedURL = url
                            } else if let urlData = item as? Data, let url = URL(dataRepresentation: urlData, relativeTo: nil) {
                                sharedURL = url
                            }
                            self?.handleSharedContent(url: sharedURL, text: sharedText)
                        }
                    }
                    return // Only handle the first URL
                }
            }
        }

        // No URL found
        close()
    }

    private func handleSharedContent(url: URL?, text: String?) {
        // Try to extract artist from URL first
        let artistFromURL = url.flatMap { extractArtistFromURL($0) }

        // Try to extract artist from share text (e.g. "Song Name by Artist Name" from Apple Music)
        let artistFromText = text.flatMap { extractArtistFromText($0) }

        // Priority: URL extraction > text extraction > raw URL
        let query = artistFromURL ?? artistFromText ?? url?.absoluteString ?? ""

        guard !query.isEmpty else {
            close()
            return
        }

        // Save to shared App Group UserDefaults for the main app to pick up on launch
        if let sharedDefaults = UserDefaults(suiteName: "group.lol.bgreen.unstream") {
            sharedDefaults.set(query, forKey: "pendingSearch")
            sharedDefaults.set(Date().timeIntervalSince1970, forKey: "pendingSearchTimestamp")
        }

        // Complete the extension request — the main app will check for pending searches on next launch/foreground
        close()
    }

    /// Extract artist name from known streaming service URL patterns
    private func extractArtistFromURL(_ url: URL) -> String? {
        let host = url.host?.lowercased() ?? ""
        let pathComponents = url.pathComponents

        // Bandcamp: artistname.bandcamp.com
        if host.hasSuffix(".bandcamp.com") {
            let artist = host.replacingOccurrences(of: ".bandcamp.com", with: "")
            if !artist.isEmpty && artist != "www" && artist != "daily" {
                return artist.replacingOccurrences(of: "-", with: " ")
            }
        }

        // Spotify: open.spotify.com/artist/ID or open.spotify.com/track/ID
        // We can't resolve the ID client-side, so pass the URL for API resolution
        if host == "open.spotify.com" {
            return nil // Let the app/API handle Spotify URLs
        }

        // Apple Music: music.apple.com/XX/artist/name/ID or /album/name/ID or /song/name/ID
        if host == "music.apple.com" || host.hasSuffix(".music.apple.com") {
            // Direct artist link: /artist/name/ID
            if let artistIndex = pathComponents.firstIndex(of: "artist"),
               artistIndex + 1 < pathComponents.count {
                return pathComponents[artistIndex + 1]
                    .replacingOccurrences(of: "-", with: " ")
            }
            // Album/song links: can't extract artist from URL alone, return nil to fall through to text extraction
            return nil
        }

        // SoundCloud: soundcloud.com/artistname
        if host == "soundcloud.com" || host == "www.soundcloud.com" {
            if pathComponents.count >= 2 {
                let artist = pathComponents[1]
                if !artist.isEmpty && !["search", "discover", "stream", "you", "settings"].contains(artist) {
                    return artist.replacingOccurrences(of: "-", with: " ")
                }
            }
        }

        // YouTube Music: music.youtube.com/channel/... (can't resolve)
        if host == "music.youtube.com" {
            return nil
        }

        // Tidal: tidal.com/browse/artist/ID (can't resolve)
        if host == "tidal.com" || host == "listen.tidal.com" {
            return nil
        }

        // Mirlo: mirlo.space/artistname
        if host == "mirlo.space" || host == "www.mirlo.space" {
            if pathComponents.count >= 2 {
                let artist = pathComponents[1]
                if !artist.isEmpty {
                    return artist.replacingOccurrences(of: "-", with: " ")
                }
            }
        }

        // Faircamp: typically custom domains, hard to detect
        // Fall through to nil

        return nil
    }

    /// Extract artist name from share text like "Song Name by Artist Name" or "Artist Name — Song Name"
    private func extractArtistFromText(_ text: String) -> String? {
        // Apple Music shares as "Song Name by Artist Name" or "Album Name by Artist Name"
        if let byRange = text.range(of: " by ", options: .backwards) {
            let artist = String(text[byRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !artist.isEmpty {
                return artist
            }
        }

        // Some apps use "Artist — Song" or "Artist - Song" format
        for separator in [" — ", " – ", " - "] {
            if let sepRange = text.range(of: separator) {
                let artist = String(text[..<sepRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !artist.isEmpty && !artist.contains("http") {
                    return artist
                }
            }
        }

        return nil
    }

    private func close() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
