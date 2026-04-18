import UIKit
import UniformTypeIdentifiers
import UserNotifications

class ShareViewController: UIViewController {

    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let statusLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        handleSharedItems()
    }

    private func setupUI() {
        view.backgroundColor = .systemBackground

        let stack = UIStackView(arrangedSubviews: [activityIndicator, statusLabel])
        stack.axis = .vertical
        stack.spacing = 10
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.text = "Opening Unstream…"
        statusLabel.font = .systemFont(ofSize: 15, weight: .medium)
        statusLabel.textColor = .label

        activityIndicator.startAnimating()

        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
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

        if let artist = artistFromURL {
            saveAndOpen(query: artist)
            return
        }

        let artistFromText = text.flatMap { extractArtistFromText($0) }
        if let artist = artistFromText {
            saveAndOpen(query: artist)
            return
        }

        if let url = url, isAppleMusicURL(url), let itunesID = extractAppleMusicID(url) {
            lookupAppleMusicArtist(id: itunesID) { [weak self] artist in
                DispatchQueue.main.async {
                    let query = artist ?? url.absoluteString
                    self?.saveAndOpen(query: query)
                }
            }
            return
        }

        saveAndOpen(query: url?.absoluteString ?? "")
    }

    private func saveAndOpen(query: String) {
        guard !query.isEmpty else {
            close()
            return
        }

        statusLabel.text = "Searching for \(query)…"

        if let sharedDefaults = UserDefaults(suiteName: "group.lol.bgreen.unstream") {
            sharedDefaults.set(query, forKey: "pendingSearch")
            sharedDefaults.set(Date().timeIntervalSince1970, forKey: "pendingSearchTimestamp")
            sharedDefaults.synchronize()
        }

        let encodedQuery = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        guard let appURL = URL(string: "unstream://search?q=\(encodedQuery)") else {
            close()
            return
        }

        // Brief pause so the UI settles and the extension is properly active before
        // attempting to switch to the main app.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.extensionContext?.open(appURL) { [weak self] success in
                DispatchQueue.main.async {
                    if !success {
                        // extensionContext.open() is not guaranteed to work for
                        // com.apple.share-services extensions. Fire an immediate
                        // notification so the user can reach Unstream in one tap.
                        self?.scheduleSearchNotification(query: query)
                    }
                    self?.close()
                }
            }
        }
    }

    // MARK: - Notification fallback

    private func scheduleSearchNotification(query: String) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }

            let content = UNMutableNotificationContent()
            content.title = "Open in Unstream"
            content.body = "Tap to search for \(query)"
            content.sound = .default

            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger)
            UNUserNotificationCenter.current().add(request)
        }
    }

    // MARK: - Apple Music Lookup

    private func isAppleMusicURL(_ url: URL) -> Bool {
        let host = url.host?.lowercased() ?? ""
        return host == "music.apple.com" || host.hasSuffix(".music.apple.com")
    }

    private func extractAppleMusicID(_ url: URL) -> String? {
        for component in url.pathComponents.reversed() {
            if component.allSatisfy(\.isNumber) && !component.isEmpty {
                return component
            }
        }
        return nil
    }

    private func lookupAppleMusicArtist(id: String, completion: @escaping (String?) -> Void) {
        let lookupURL = URL(string: "https://itunes.apple.com/lookup?id=\(id)")!
        let task = URLSession.shared.dataTask(with: lookupURL) { data, _, error in
            guard let data = data, error == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let results = json["results"] as? [[String: Any]],
                  let first = results.first,
                  let artistName = first["artistName"] as? String else {
                completion(nil)
                return
            }
            completion(artistName)
        }
        task.resume()
    }

    // MARK: - URL Extraction

    private func extractArtistFromURL(_ url: URL) -> String? {
        let host = url.host?.lowercased() ?? ""
        let pathComponents = url.pathComponents

        if host.hasSuffix(".bandcamp.com") {
            let artist = host.replacingOccurrences(of: ".bandcamp.com", with: "")
            if !artist.isEmpty && artist != "www" && artist != "daily" {
                return artist.replacingOccurrences(of: "-", with: " ")
            }
        }

        if host == "open.spotify.com" { return nil }

        if isAppleMusicURL(url) {
            if let artistIndex = pathComponents.firstIndex(of: "artist"),
               artistIndex + 1 < pathComponents.count {
                return pathComponents[artistIndex + 1]
                    .replacingOccurrences(of: "-", with: " ")
            }
            return nil
        }

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

        if host == "mirlo.space" || host == "www.mirlo.space" {
            if pathComponents.count >= 2 {
                let artist = pathComponents[1]
                if !artist.isEmpty { return artist.replacingOccurrences(of: "-", with: " ") }
            }
        }

        return nil
    }

    // MARK: - Text Extraction

    private func extractArtistFromText(_ text: String) -> String? {
        var cleaned = text
        for suffix in [" on Apple Music", " on Spotify", " on SoundCloud", " on YouTube Music", " on TIDAL"] {
            if cleaned.hasSuffix(suffix) {
                cleaned = String(cleaned.dropLast(suffix.count))
            }
        }

        if let byRange = cleaned.range(of: " by ", options: .backwards) {
            let artist = String(cleaned[byRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !artist.isEmpty { return artist }
        }

        for separator in [" — ", " – ", " - "] {
            if let sepRange = cleaned.range(of: separator) {
                let artist = String(cleaned[..<sepRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !artist.isEmpty && !artist.contains("http") { return artist }
            }
        }

        return nil
    }

    // MARK: - Helpers

    private func close() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
