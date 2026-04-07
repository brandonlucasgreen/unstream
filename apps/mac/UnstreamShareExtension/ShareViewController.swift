import UIKit
import UniformTypeIdentifiers

class ShareViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()
        view.isHidden = true
        handleSharedItems()
    }

    private func handleSharedItems() {
        guard let extensionItems = extensionContext?.inputItems as? [NSExtensionItem] else {
            close()
            return
        }

        var sharedURL: URL?
        var sharedText: String?
        var pendingLoads = 0
        var completedLoads = 0

        for item in extensionItems {
            if let text = item.attributedContentText?.string, !text.isEmpty {
                sharedText = text
            }

            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    pendingLoads += 1
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, _ in
                        DispatchQueue.main.async {
                            if let url = item as? URL {
                                sharedURL = url
                            } else if let urlData = item as? Data, let url = URL(dataRepresentation: urlData, relativeTo: nil) {
                                sharedURL = url
                            }
                            completedLoads += 1
                            if completedLoads >= pendingLoads {
                                self?.handleSharedContent(url: sharedURL, text: sharedText)
                            }
                        }
                    }
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    pendingLoads += 1
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { [weak self] item, _ in
                        DispatchQueue.main.async {
                            if let text = item as? String, !text.isEmpty, !text.hasPrefix("http") {
                                sharedText = text
                            }
                            completedLoads += 1
                            if completedLoads >= pendingLoads {
                                self?.handleSharedContent(url: sharedURL, text: sharedText)
                            }
                        }
                    }
                }
            }
        }

        if pendingLoads == 0 {
            close()
        }
    }

    private func handleSharedContent(url: URL?, text: String?) {
        let artistFromURL = url.flatMap { extractArtistFromURL($0) }
        let artistFromText = text.flatMap { extractArtistFromText($0) }
        let query = artistFromURL ?? artistFromText ?? url?.absoluteString ?? ""

        guard !query.isEmpty else {
            close()
            return
        }

        // Save to App Group for the main app
        if let sharedDefaults = UserDefaults(suiteName: "group.lol.bgreen.unstream") {
            sharedDefaults.set(query, forKey: "pendingSearch")
            sharedDefaults.set(Date().timeIntervalSince1970, forKey: "pendingSearchTimestamp")
            sharedDefaults.synchronize()
        }

        // Open the main app via URL scheme using the responder chain.
        // extensionContext?.open() is NOT available in share extensions.
        // The responder chain approach is the standard workaround used by
        // production apps (WhatsApp, Telegram, etc.) to open the containing app.
        let encodedQuery = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        if let appURL = URL(string: "unstream://search?q=\(encodedQuery)") {
            openURL(appURL)
        }

        // Small delay to let the URL open before dismissing
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.close()
        }
    }

    /// Open a URL from within an extension using the responder chain
    private func openURL(_ url: URL) {
        var responder: UIResponder? = self
        while let r = responder {
            if let application = r as? UIApplication {
                application.open(url, options: [:], completionHandler: nil)
                return
            }
            // Use selector to find openURL on the shared application
            let selector = sel_registerName("openURL:")
            if r.responds(to: selector) {
                r.perform(selector, with: url)
                return
            }
            responder = r.next
        }
    }

    // MARK: - URL Extraction

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

        // Spotify: can't resolve IDs client-side
        if host == "open.spotify.com" {
            return nil
        }

        // Apple Music: /artist/name/ID extracts directly, /album/ and /song/ fall through to text
        if host == "music.apple.com" || host.hasSuffix(".music.apple.com") {
            if let artistIndex = pathComponents.firstIndex(of: "artist"),
               artistIndex + 1 < pathComponents.count {
                return pathComponents[artistIndex + 1]
                    .replacingOccurrences(of: "-", with: " ")
            }
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

        if host == "music.youtube.com" { return nil }
        if host == "tidal.com" || host == "listen.tidal.com" { return nil }

        // Mirlo: mirlo.space/artistname
        if host == "mirlo.space" || host == "www.mirlo.space" {
            if pathComponents.count >= 2 {
                let artist = pathComponents[1]
                if !artist.isEmpty {
                    return artist.replacingOccurrences(of: "-", with: " ")
                }
            }
        }

        return nil
    }

    // MARK: - Text Extraction

    private func extractArtistFromText(_ text: String) -> String? {
        // Strip common suffixes from share sheet text
        var cleaned = text
        for suffix in [" on Apple Music", " on Spotify", " on SoundCloud", " on YouTube Music", " on TIDAL"] {
            if cleaned.hasSuffix(suffix) {
                cleaned = String(cleaned.dropLast(suffix.count))
            }
        }

        // Apple Music: "Album Name by Artist Name" or "Song Name by Artist Name"
        if let byRange = cleaned.range(of: " by ", options: .backwards) {
            let artist = String(cleaned[byRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !artist.isEmpty {
                return artist
            }
        }

        // "Artist — Song" or "Artist - Song"
        for separator in [" — ", " – ", " - "] {
            if let sepRange = cleaned.range(of: separator) {
                let artist = String(cleaned[..<sepRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !artist.isEmpty && !artist.contains("http") {
                    return artist
                }
            }
        }

        // If the cleaned text is short and doesn't look like a URL, it might be an artist name directly
        if !cleaned.contains("http") && !cleaned.contains("/") && cleaned.count < 100 {
            return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return nil
    }

    private func close() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
