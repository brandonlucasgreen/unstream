import Foundation
import SwiftUI

@MainActor
class AppState: ObservableObject {
    // Search state
    @Published var searchQuery: String = ""
    @Published var searchResults: [ArtistResult] = []
    @Published var isSearching: Bool = false
    @Published var searchError: String? = nil
    @Published var hasSearched: Bool = false

    // Tab selection (iOS)
    @Published var selectedTab: Int = 0

    // Now Playing state
    @Published var nowPlaying: NowPlaying? = nil
    @Published var isPlaying: Bool = false
    @Published var nowPlayingResults: [ArtistResult] = []
    /// Where the lookup for the playing artist stands. A successful empty answer and a failure
    /// both used to leave "Searching for platforms..." on screen forever.
    @Published private(set) var nowPlayingLookup: NowPlayingLookup = .idle

    enum NowPlayingLookup: Equatable {
        case idle
        case loading
        case loaded      // answered; `nowPlayingResults` may be empty
        case failed
    }

    var isLoadingNowPlaying: Bool { nowPlayingLookup == .loading }

    // Request generations. Each search bumps its counter and checks it after every await before
    // writing anything: without that, Phase 1 or Phase 2 of an earlier search (a typed one, or
    // the previous track's artist) could land after a newer one and show artist A's destinations
    // under artist B's name. A `Task` cancel wouldn't be enough on its own — URLSession work
    // that has already returned still resumes — so the check is what makes stale writes impossible.
    private var searchGeneration = 0
    private var nowPlayingGeneration = 0

    // Cache to avoid redundant API calls
    private var lastFetchedArtist: String? = nil
    private var lastFetchTime: Date? = nil
    private let minFetchInterval: TimeInterval = 30 // Don't re-fetch same artist within 30 seconds

    // Called after Phase 1 results arrive for a newly detected now-playing artist
    var onArtistResultsReady: ((String, [ArtistResult]) async -> Void)?

    // Display mode
    enum DisplayMode {
        case empty
        case nowPlaying
        case searchResults
    }

    var displayMode: DisplayMode {
        if !searchResults.isEmpty || isSearching || hasSearched {
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
        searchGeneration += 1
        let generation = searchGeneration
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchResults = []
            return
        }

        hasSearched = true
        isSearching = true
        searchError = nil

        do {
            // Phase 1: Get initial results — show them immediately.
            // Typed search is fuzzy so partial names can find artists;
            // now-playing detection below stays exact.
            let (results, hasPendingEnrichment) = try await api.searchArtist(query, mode: .fuzzy)
            guard generation == searchGeneration else { return }
            searchResults = results
            isSearching = false
            // The one 'search' product event per query, written on completion so it carries the
            // outcome. There used to be a second, context-free one fired before the request —
            // the same double-write the web app removed on 2026-08-19 — which doubled the Mac
            // app's search counts in /admin/analytics and doubled the database writes for it.
            // search_kind tells /admin/analytics a typed search from a now-playing one.
            api.trackAppEvent(eventType: "search", context: ["has_results": results.count > 0, "result_count": results.count, "search_kind": "typed"])
            trackSearchAppearances(results)

            // Phase 2: Enrich with MusicBrainz data in the background. Its failure keeps the
            // Phase 1 results on screen rather than replacing them with a search error.
            if hasPendingEnrichment {
                do {
                    if let mbData = try await api.fetchMusicBrainzData(query) {
                        let enrichedResults = await api.mergeWithMusicBrainzData(results: results, mbData: mbData)
                        guard generation == searchGeneration else { return }
                        searchResults = enrichedResults
                        await api.cacheResults(query: query, results: enrichedResults, mode: .fuzzy)
                    }
                } catch {
                    print("Search enrichment error: \(error)")
                }
            }
        } catch {
            guard generation == searchGeneration else { return }
            searchError = "Failed to search. Please try again."
            isSearching = false
            print("Search error: \(error)")
        }
    }

    func clearSearch() {
        searchGeneration += 1  // anything still in flight is for a search the user abandoned
        isSearching = false
        searchQuery = ""
        searchResults = []
        searchError = nil
        hasSearched = false
    }

    /// Clear results only (preserves query text for re-search)
    func clearResults() {
        searchGeneration += 1
        isSearching = false
        searchResults = []
        searchError = nil
        hasSearched = false
    }

    func updateNowPlaying(_ nowPlaying: NowPlaying?) async {
        let previousArtist = self.nowPlaying?.artist
        self.nowPlaying = nowPlaying
        self.isPlaying = nowPlaying != nil && nowPlaying!.hasContent

        guard let artist = nowPlaying?.artist, !artist.isEmpty else {
            // No artist playing - clear results, and drop any lookup still in flight
            nowPlayingGeneration += 1
            if nowPlayingResults.isEmpty == false {
                nowPlayingResults = []
            }
            nowPlayingLookup = .idle
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
            await fetchNowPlayingPlatforms(for: artist)
        }
    }

    /// Look the playing artist up again after a failure (the Retry in the now-playing view).
    func retryNowPlaying() async {
        guard let artist = nowPlaying?.artist, !artist.isEmpty else { return }
        await fetchNowPlayingPlatforms(for: artist)
    }

    private func fetchNowPlayingPlatforms(for artist: String) async {
        nowPlayingGeneration += 1
        let generation = nowPlayingGeneration
        nowPlayingLookup = .loading
        // Never show the previous track's destinations under this artist while loading.
        if lastFetchedArtist?.lowercased() != artist.lowercased() {
            nowPlayingResults = []
        }

        do {
            print("[AppState] Fetching platforms for: \(artist)")
            // Phase 1: Get initial results — show them immediately
            let (results, hasPendingEnrichment) = try await api.searchArtist(artist)
            guard generation == nowPlayingGeneration else { return }
            nowPlayingResults = results
            lastFetchedArtist = artist
            lastFetchTime = Date()
            nowPlayingLookup = .loaded
            api.trackAppEvent(eventType: "search", context: ["has_results": results.count > 0, "result_count": results.count, "search_kind": "now_playing"])
            trackSearchAppearances(results)
            print("[AppState] Got \(results.count) results for \(artist)")
            if let callback = onArtistResultsReady {
                await callback(artist, results)
            }

            // Phase 2: Enrich with MusicBrainz data in the background; a failure keeps Phase 1.
            if hasPendingEnrichment {
                do {
                    if let mbData = try await api.fetchMusicBrainzData(artist) {
                        let enrichedResults = await api.mergeWithMusicBrainzData(results: results, mbData: mbData)
                        guard generation == nowPlayingGeneration else { return }
                        nowPlayingResults = enrichedResults
                        await api.cacheResults(query: artist, results: enrichedResults)
                        print("[AppState] Enriched with MusicBrainz data")
                    }
                } catch {
                    print("[AppState] Now playing enrichment error: \(error)")
                }
            }
        } catch {
            guard generation == nowPlayingGeneration else { return }
            print("[AppState] Now playing search error: \(error)")
            nowPlayingLookup = .failed
        }
    }

    // MARK: - Analytics

    /// Track search appearances for claimed artists in the results
    private func trackSearchAppearances(_ results: [ArtistResult]) {
        for result in results {
            if result.type == "artist", let slug = result.claimedSlug {
                api.trackAnalyticsEvent(slug: slug, metric: "search")
            }
        }
    }

    /// Track a platform link click for a claimed artist + product analytics
    func trackLinkClick(artist: ArtistResult, platformId: String) {
        if let slug = artist.claimedSlug {
            api.trackAnalyticsEvent(slug: slug, metric: "click:\(platformId)")
        }
        api.trackAppEvent(eventType: "platform_click", context: ["platform": platformId])
    }
}
