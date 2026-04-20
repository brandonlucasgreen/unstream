import Foundation
import SwiftUI

// MARK: - Model

struct IndieArtist: Codable, Identifiable, Equatable {
    let slug: String
    let name: String
    let imageUrl: String?

    var id: String { slug }
}

// MARK: - Service

@MainActor
class IndieArtistDirectoryService: ObservableObject {
    enum LoadState {
        case idle
        case loading
        case loaded
        case failed
    }

    @Published private(set) var artists: [IndieArtist] = []
    @Published private(set) var sample: [IndieArtist] = []
    @Published private(set) var loadState: LoadState = .idle

    private let api: UnstreamAPI
    private let sampleSize = 30
    private let cacheFileName = "indie-artist-directory.json"
    private var isFetching = false

    init(api: UnstreamAPI = UnstreamAPI()) {
        self.api = api
        loadFromCache()
        if !artists.isEmpty {
            self.loadState = .loaded
            self.sample = pickSample(from: artists)
        }
    }

    /// Fetches the directory if we haven't loaded it yet this session, or refreshes
    /// silently in the background. Does NOT reshuffle an existing sample — only
    /// `refresh()` (pull-to-refresh) does that.
    func loadIfNeeded() async {
        guard !isFetching else { return }
        let hadSample = !sample.isEmpty
        isFetching = true
        loadState = .loading
        do {
            let fetched = try await api.fetchArtistDirectory()
            self.artists = fetched
            saveToCache(fetched)
            if !hadSample {
                self.sample = pickSample(from: fetched)
            }
            self.loadState = .loaded
        } catch {
            // Keep any cached artists — only mark failed if we have nothing to show.
            if artists.isEmpty {
                self.loadState = .failed
            } else {
                self.loadState = .loaded
            }
        }
        isFetching = false
    }

    /// Pull-to-refresh: re-fetches and reshuffles regardless of fetch outcome.
    func refresh() async {
        guard !isFetching else {
            // Already fetching — reshuffle from whatever we have
            self.sample = pickSample(from: artists)
            return
        }
        isFetching = true
        do {
            let fetched = try await api.fetchArtistDirectory()
            self.artists = fetched
            saveToCache(fetched)
        } catch {
            // Ignore — we still reshuffle from existing data so the user sees change.
        }
        self.sample = pickSample(from: artists)
        if !artists.isEmpty {
            self.loadState = .loaded
        }
        isFetching = false
    }

    private func pickSample(from source: [IndieArtist]) -> [IndieArtist] {
        guard !source.isEmpty else { return [] }
        return Array(source.shuffled().prefix(sampleSize))
    }

    // MARK: - Cache

    private var cacheURL: URL? {
        guard let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        return dir.appendingPathComponent(cacheFileName)
    }

    private func loadFromCache() {
        guard let url = cacheURL,
              FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([IndieArtist].self, from: data) else {
            return
        }
        self.artists = decoded
    }

    private func saveToCache(_ artists: [IndieArtist]) {
        guard let url = cacheURL,
              let data = try? JSONEncoder().encode(artists) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
