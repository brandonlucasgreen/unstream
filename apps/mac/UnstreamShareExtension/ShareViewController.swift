import UIKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - API Models

private struct SearchAPIResponse: Decodable {
    let results: [SearchAPIResult]
}

private struct SearchAPIResult: Decodable {
    let name: String
    let type: String
    let platforms: [PlatformLinkData]
}

struct PlatformLinkData: Decodable, Identifiable {
    let sourceId: String
    let url: String
    let displayName: String?
    var id: String { sourceId }
}

// MARK: - Platform Metadata

struct PlatformMeta {
    let name: String
    let icon: String
    let payoutPercent: String?
    let isSocial: Bool
}

private let allPlatformMeta: [String: PlatformMeta] = [
    "bandcamp":     .init(name: "Bandcamp",        icon: "🎵", payoutPercent: "80–85%", isSocial: false),
    "mirlo":        .init(name: "Mirlo",           icon: "🪺", payoutPercent: "86–90%", isSocial: false),
    "ampwall":      .init(name: "Ampwall",         icon: "🔊", payoutPercent: "92–95%", isSocial: false),
    "bandwagon":    .init(name: "Bandwagon",       icon: "🚐", payoutPercent: nil,       isSocial: false),
    "faircamp":     .init(name: "Faircamp",        icon: "🏕️", payoutPercent: "90–97%", isSocial: false),
    "patreon":      .init(name: "Patreon",         icon: "🎨", payoutPercent: "86–90%", isSocial: false),
    "buymeacoffee": .init(name: "Buy Me a Coffee", icon: "☕", payoutPercent: "~92%",   isSocial: false),
    "kofi":         .init(name: "Ko-fi",           icon: "🍵", payoutPercent: "92–97%", isSocial: false),
    "hoopla":       .init(name: "Hoopla",          icon: "🎧", payoutPercent: nil,       isSocial: false),
    "freegal":      .init(name: "Freegal",         icon: "🎵", payoutPercent: nil,       isSocial: false),
    "qobuz":        .init(name: "Qobuz",           icon: "💿", payoutPercent: "~70%",   isSocial: false),
    "beatport":     .init(name: "Beatport",        icon: "🎛️", payoutPercent: "55–70%", isSocial: false),
    "even":         .init(name: "EVEN",            icon: "🎤", payoutPercent: "~80%",   isSocial: false),
    "jamcoop":      .init(name: "Jam.coop",        icon: "🎸", payoutPercent: nil,       isSocial: false),
    "officialsite": .init(name: "Official Site",   icon: "🌐", payoutPercent: nil,       isSocial: false),
    "discogs":      .init(name: "Discogs",         icon: "💿", payoutPercent: nil,       isSocial: false),
    "instagram":    .init(name: "Instagram",       icon: "📸", payoutPercent: nil,       isSocial: true),
    "facebook":     .init(name: "Facebook",        icon: "👥", payoutPercent: nil,       isSocial: true),
    "tiktok":       .init(name: "TikTok",          icon: "🎬", payoutPercent: nil,       isSocial: true),
    "youtube":      .init(name: "YouTube",         icon: "▶️", payoutPercent: nil,       isSocial: true),
    "threads":      .init(name: "Threads",         icon: "🧵", payoutPercent: nil,       isSocial: true),
    "bluesky":      .init(name: "Bluesky",         icon: "🦋", payoutPercent: nil,       isSocial: true),
    "mastodon":     .init(name: "Mastodon",        icon: "🐘", payoutPercent: nil,       isSocial: true),
    "peertube":     .init(name: "PeerTube",        icon: "📹", payoutPercent: nil,       isSocial: true),
]

// MARK: - View Model

@MainActor
class ShareSearchViewModel: ObservableObject {
    enum SearchState {
        case extracting
        case loading(String)
        case results(artistName: String, platforms: [PlatformLinkData])
        case empty(String)
        case networkError
    }

    @Published var searchState: SearchState = .extracting
    private(set) var artistQuery = ""

    func search(for artist: String) {
        artistQuery = artist
        searchState = .loading(artist)
        Task { await performSearch(artist: artist) }
    }

    private func performSearch(artist: String) async {
        savePendingSearch(artist)

        guard let encoded = artist.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "https://unstream.stream/api/search/sources?query=\(encoded)") else {
            searchState = .networkError
            return
        }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let response = try JSONDecoder().decode(SearchAPIResponse.self, from: data)
            let best = response.results.first { $0.type == "artist" } ?? response.results.first

            if let result = best, !result.platforms.isEmpty {
                searchState = .results(artistName: result.name, platforms: result.platforms)
            } else {
                searchState = .empty(artist)
            }
        } catch {
            searchState = .networkError
        }
    }

    private func savePendingSearch(_ query: String) {
        guard let defaults = UserDefaults(suiteName: "group.lol.bgreen.unstream") else { return }
        defaults.set(query, forKey: "pendingSearch")
        defaults.set(Date().timeIntervalSince1970, forKey: "pendingSearchTimestamp")
        defaults.synchronize()
    }
}

// MARK: - Root View

struct ShareSearchView: View {
    @ObservedObject var viewModel: ShareSearchViewModel
    let onOpenURL: (URL) -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Unstream")
                    .font(.system(size: 15, weight: .semibold))
                Spacer()
                Button("Done", action: onDismiss)
                    .font(.system(size: 15, weight: .medium))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider()
            mainContent
        }
        .background(Color(.systemBackground))
    }

    @ViewBuilder
    private var mainContent: some View {
        switch viewModel.searchState {
        case .extracting:
            statusView(spinner: true, message: "Identifying artist…")
        case .loading(let name):
            statusView(spinner: true, message: "Searching for \(name)…")
        case .results(let artistName, let platforms):
            ResultsView(
                artistName: artistName,
                platforms: platforms,
                onOpenURL: onOpenURL,
                onOpenUnstream: { openInUnstream(artist: artistName) }
            )
        case .empty(let name):
            statusView(spinner: false, message: "No results found for "\(name)"")
                .safeAreaInset(edge: .bottom) { openUnstreamButton(artist: name) }
        case .networkError:
            statusView(spinner: false, message: "Search unavailable. Open Unstream to try again.")
                .safeAreaInset(edge: .bottom) { openUnstreamButton(artist: viewModel.artistQuery) }
        }
    }

    private func statusView(spinner: Bool, message: String) -> some View {
        VStack(spacing: 12) {
            if spinner { ProgressView() }
            Text(message)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 100)
        .padding()
    }

    private func openUnstreamButton(artist: String) -> some View {
        Button { openInUnstream(artist: artist) } label: {
            Label("Open in Unstream", systemImage: "arrow.up.right.square")
                .font(.subheadline)
        }
        .buttonStyle(.bordered)
        .padding(.bottom, 16)
    }

    private func openInUnstream(artist: String) {
        guard !artist.isEmpty,
              let encoded = artist.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "unstream://search?q=\(encoded)") else {
            onDismiss()
            return
        }
        onOpenURL(url)
    }
}

// MARK: - Results View

private struct ResultsView: View {
    let artistName: String
    let platforms: [PlatformLinkData]
    let onOpenURL: (URL) -> Void
    let onOpenUnstream: () -> Void

    private var primary: [PlatformLinkData] {
        platforms.filter { allPlatformMeta[$0.sourceId]?.isSocial != true }
    }

    private var socialCount: Int {
        platforms.filter { allPlatformMeta[$0.sourceId]?.isSocial == true }.count
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                artistHeader
                Divider()
                platformRows
                Divider()
                openUnstreamRow
            }
        }
    }

    private var artistHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(artistName)
                    .font(.headline)
                Text(summaryLine)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var summaryLine: String {
        let n = primary.count
        let base = "Found on \(n) platform\(n == 1 ? "" : "s")"
        return socialCount > 0 ? "\(base) · \(socialCount) social" : base
    }

    private var platformRows: some View {
        ForEach(Array(primary.enumerated()), id: \.element.id) { index, platform in
            if let url = URL(string: platform.url) {
                PlatformRow(platform: platform) { onOpenURL(url) }
                if index < primary.count - 1 {
                    Divider().padding(.leading, 52)
                }
            }
        }
    }

    private var openUnstreamRow: some View {
        Button(action: onOpenUnstream) {
            HStack {
                Image(systemName: "arrow.up.right.square")
                    .frame(width: 36)
                    .foregroundColor(.accentColor)
                Text("Open full results in Unstream")
                    .font(.body)
                    .foregroundColor(.accentColor)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Platform Row

private struct PlatformRow: View {
    let platform: PlatformLinkData
    let onTap: () -> Void

    private var meta: PlatformMeta? { allPlatformMeta[platform.sourceId] }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Text(meta?.icon ?? "🎵")
                    .font(.title3)
                    .frame(width: 36, height: 36)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 2) {
                    Text(meta?.name ?? platform.displayName ?? platform.sourceId)
                        .font(.body)
                        .foregroundColor(.primary)
                    if let payout = meta?.payoutPercent {
                        Text("\(payout) to artist")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - View Controller

class ShareViewController: UIViewController {

    private let viewModel = ShareSearchViewModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = CGSize(width: 0, height: 420)
        embedSearchView()
        extractArtist()
    }

    private func embedSearchView() {
        let rootView = ShareSearchView(
            viewModel: viewModel,
            onOpenURL: { [weak self] url in
                self?.extensionContext?.open(url) { [weak self] _ in
                    DispatchQueue.main.async {
                        self?.extensionContext?.completeRequest(returningItems: nil)
                    }
                }
            },
            onDismiss: { [weak self] in
                self?.extensionContext?.completeRequest(returningItems: nil)
            }
        )

        let host = UIHostingController(rootView: rootView)
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
    }

    private func extractArtist() {
        guard let extensionItems = extensionContext?.inputItems as? [NSExtensionItem] else {
            extensionContext?.completeRequest(returningItems: nil)
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
                            } else if let data = item as? Data,
                                      let url = URL(dataRepresentation: data, relativeTo: nil) {
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
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private func handleSharedContent(url: URL?, text: String?) {
        if let artist = url.flatMap(extractArtistFromURL) {
            viewModel.search(for: artist)
            return
        }

        if let artist = text.flatMap(extractArtistFromText) {
            viewModel.search(for: artist)
            return
        }

        if let url = url, isAppleMusicURL(url), let id = extractAppleMusicID(url) {
            lookupAppleMusicArtist(id: id) { [weak self] artist in
                DispatchQueue.main.async {
                    self?.viewModel.search(for: artist ?? url.absoluteString)
                }
            }
            return
        }

        if let raw = url?.absoluteString {
            viewModel.search(for: raw)
        } else {
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    // MARK: - Apple Music Lookup

    private func isAppleMusicURL(_ url: URL) -> Bool {
        let host = url.host?.lowercased() ?? ""
        return host == "music.apple.com" || host.hasSuffix(".music.apple.com")
    }

    private func extractAppleMusicID(_ url: URL) -> String? {
        url.pathComponents.reversed().first { $0.allSatisfy(\.isNumber) && !$0.isEmpty }
    }

    private func lookupAppleMusicArtist(id: String, completion: @escaping (String?) -> Void) {
        let url = URL(string: "https://itunes.apple.com/lookup?id=\(id)")!
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let results = json["results"] as? [[String: Any]],
                  let artistName = results.first?["artistName"] as? String else {
                completion(nil)
                return
            }
            completion(artistName)
        }.resume()
    }

    // MARK: - URL Extraction

    private func extractArtistFromURL(_ url: URL) -> String? {
        let host = url.host?.lowercased() ?? ""
        let parts = url.pathComponents

        if host.hasSuffix(".bandcamp.com") {
            let artist = host.replacingOccurrences(of: ".bandcamp.com", with: "")
            if !artist.isEmpty && artist != "www" && artist != "daily" {
                return artist.replacingOccurrences(of: "-", with: " ")
            }
        }

        if host == "open.spotify.com" { return nil }

        if isAppleMusicURL(url) {
            if let idx = parts.firstIndex(of: "artist"), idx + 1 < parts.count {
                return parts[idx + 1].replacingOccurrences(of: "-", with: " ")
            }
            return nil
        }

        if host == "soundcloud.com" || host == "www.soundcloud.com", parts.count >= 2 {
            let artist = parts[1]
            if !artist.isEmpty && !["search", "discover", "stream", "you", "settings"].contains(artist) {
                return artist.replacingOccurrences(of: "-", with: " ")
            }
        }

        if host == "music.youtube.com" { return nil }
        if host == "tidal.com" || host == "listen.tidal.com" { return nil }

        if host == "mirlo.space" || host == "www.mirlo.space", parts.count >= 2 {
            let artist = parts[1]
            if !artist.isEmpty { return artist.replacingOccurrences(of: "-", with: " ") }
        }

        return nil
    }

    // MARK: - Text Extraction

    private func extractArtistFromText(_ text: String) -> String? {
        var cleaned = text
        var hadSuffix = false
        for suffix in [" on Apple Music", " on Spotify", " on SoundCloud", " on YouTube Music", " on TIDAL"] {
            if cleaned.hasSuffix(suffix) {
                cleaned = String(cleaned.dropLast(suffix.count))
                hadSuffix = true
            }
        }

        if let range = cleaned.range(of: " by ", options: .backwards) {
            let artist = String(cleaned[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !artist.isEmpty { return artist }
        }

        for sep in [" — ", " – ", " - "] {
            if let range = cleaned.range(of: sep) {
                let artist = String(cleaned[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !artist.isEmpty && !artist.contains("http") { return artist }
            }
        }

        // "Artist Name on Spotify" → after stripping suffix, return the name directly
        if hadSuffix && !cleaned.isEmpty && !cleaned.contains("http") {
            return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return nil
    }
}
