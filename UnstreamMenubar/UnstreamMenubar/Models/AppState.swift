import Foundation
import SwiftUI

@MainActor
class AppState: ObservableObject {
    // Search state
    @Published var searchQuery: String = ""
    @Published var searchResults: [ArtistResult] = []
    @Published var isSearching: Bool = false
    @Published var searchError: String? = nil

    // Now Playing state
    @Published var nowPlaying: NowPlaying? = nil
    @Published var isPlaying: Bool = false
    @Published var nowPlayingResults: [ArtistResult] = []
    @Published var isLoadingNowPlaying: Bool = false

    // Cache to avoid redundant API calls
    private var lastFetchedArtist: String? = nil
    private var lastFetchTime: Date? = nil
    private let minFetchInterval: TimeInterval = 30 // Don't re-fetch same artist within 30 seconds

    // Display mode
    enum DisplayMode {
        case empty
        case nowPlaying
        case searchResults
    }

    var displayMode: DisplayMode {
        if !searchResults.isEmpty || isSearching || !searchQuery.isEmpty {
            return .searchResults
        } else if nowPlaying != nil && nowPlaying!.hasContent {
            return .nowPlaying
        } else {
            return .empty
        }
    }

    var currentArtist: String? {
        switch displayMode {
        case .searchResults:
            return searchQuery.isEmpty ? nil : searchQuery
        case .nowPlaying:
            return nowPlaying?.artist
        case .empty:
            return nil
        }
    }

    var currentResults: [ArtistResult] {
        switch displayMode {
        case .searchResults:
            return searchResults
        case .nowPlaying:
            return nowPlayingResults
        case .empty:
            return []
        }
    }

    private let api = UnstreamAPI()

    func performSearch() async {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchResults = []
            return
        }

        isSearching = true
        searchError = nil

        do {
            let results = try await api.searchArtist(query)
            searchResults = results
        } catch {
            searchError = "Failed to search. Please try again."
            print("Search error: \(error)")
        }

        isSearching = false
    }

    func clearSearch() {
        searchQuery = ""
        searchResults = []
        searchError = nil
    }

    func updateNowPlaying(_ nowPlaying: NowPlaying?) async {
        let previousArtist = self.nowPlaying?.artist
        self.nowPlaying = nowPlaying
        self.isPlaying = nowPlaying != nil && nowPlaying!.hasContent

        guard let artist = nowPlaying?.artist, !artist.isEmpty else {
            // No artist playing - clear results
            if nowPlayingResults.isEmpty == false {
                nowPlayingResults = []
            }
            lastFetchedArtist = nil
            return
        }

        // Don't fetch if we're showing manual search results
        if !searchResults.isEmpty || !searchQuery.isEmpty {
            return
        }

        // Check if we need to fetch
        let artistChanged = artist.lowercased() != previousArtist?.lowercased()
        let needsInitialFetch = nowPlayingResults.isEmpty && lastFetchedArtist?.lowercased() != artist.lowercased()
        let cacheExpired = lastFetchTime == nil || Date().timeIntervalSince(lastFetchTime!) > minFetchInterval

        // Fetch if: artist changed, OR we have no results for this artist, OR cache expired
        if artistChanged || needsInitialFetch || (artist.lowercased() != lastFetchedArtist?.lowercased() && cacheExpired) {
            isLoadingNowPlaying = true

            do {
                print("[AppState] Fetching platforms for: \(artist)")
                let results = try await api.searchArtist(artist)
                nowPlayingResults = results
                lastFetchedArtist = artist
                lastFetchTime = Date()
                print("[AppState] Got \(results.count) results for \(artist)")
            } catch {
                print("[AppState] Now playing search error: \(error)")
            }

            isLoadingNowPlaying = false
        }
    }
}
