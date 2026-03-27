import UIKit
import UniformTypeIdentifiers

class ShareViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()

        // Process shared items immediately
        handleSharedItems()
    }

    private func handleSharedItems() {
        guard let extensionItems = extensionContext?.inputItems as? [NSExtensionItem] else {
            close()
            return
        }

        for item in extensionItems {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, error in
                        DispatchQueue.main.async {
                            if let url = item as? URL {
                                self?.handleURL(url)
                            } else if let urlData = item as? Data, let url = URL(dataRepresentation: urlData, relativeTo: nil) {
                                self?.handleURL(url)
                            } else {
                                self?.close()
                            }
                        }
                    }
                    return // Only handle the first URL
                }
            }
        }

        // No URL found
        close()
    }

    private func handleURL(_ url: URL) {
        let query = extractArtistFromURL(url) ?? url.absoluteString

        // Save to shared App Group UserDefaults
        if let sharedDefaults = UserDefaults(suiteName: "group.lol.bgreen.unstream") {
            sharedDefaults.set(query, forKey: "pendingSearch")
        }

        // Try to open the main app via URL scheme
        if let encodedQuery = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let appURL = URL(string: "unstream://search?q=\(encodedQuery)") {
            // Use responder chain to open URL (share extensions can't use UIApplication.shared)
            var responder: UIResponder? = self
            while let nextResponder = responder?.next {
                if let application = nextResponder as? UIApplication {
                    application.open(appURL)
                    break
                }
                responder = nextResponder
            }
        }

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

        // Apple Music: music.apple.com/XX/artist/name/ID
        if host == "music.apple.com" || host.hasSuffix(".music.apple.com") {
            if let artistIndex = pathComponents.firstIndex(of: "artist"),
               artistIndex + 1 < pathComponents.count {
                return pathComponents[artistIndex + 1]
                    .replacingOccurrences(of: "-", with: " ")
            }
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

    private func close() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
