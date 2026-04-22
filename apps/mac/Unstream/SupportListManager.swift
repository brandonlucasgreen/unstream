import Foundation
import SwiftUI

@MainActor
class SupportListManager: ObservableObject {
    @Published private(set) var entries: [SupportEntry] = []
    @Published var searchQuery: String = ""
    @Published private(set) var refreshingEntryIds: Set<UUID> = []

    private let api = UnstreamAPI()

    var filteredEntries: [SupportEntry] {
        guard !searchQuery.isEmpty else { return entries }
        return entries.filter { entry in
            entry.artistName.localizedCaseInsensitiveContains(searchQuery)
        }
    }

    private static let maxEntries = 500
    private var isMerging = false

    private let storageKey = "supportList"
    private let iCloudStore = NSUbiquitousKeyValueStore.default

    init() {
        loadEntries()
        setupiCloudObserver()
    }

    // MARK: - Public Methods

    func clearSearch() {
        searchQuery = ""
    }

    func addArtist(_ artist: ArtistResult) {
        // Don't add duplicates (check by artist name, case-insensitive)
        guard !entries.contains(where: { $0.artistName.lowercased() == artist.name.lowercased() }) else {
            return
        }

        let entry = SupportEntry(from: artist)
        entries.insert(entry, at: 0) // Add to top
        saveEntries()
    }

    func removeEntry(_ entry: SupportEntry) {
        entries.removeAll { $0.id == entry.id }
        saveEntries()
    }

    func removeEntry(at offsets: IndexSet) {
        entries.remove(atOffsets: offsets)
        saveEntries()
    }

    func isArtistSaved(_ artistName: String) -> Bool {
        entries.contains { $0.artistName.lowercased() == artistName.lowercased() }
    }

    /// Called by the main app when it finds a `pendingSaveArtist` queued by the share extension.
    func addEntryFromExtension(name: String, imageUrl: String?, platforms: [(sourceId: String, url: String)]) {
        guard !entries.contains(where: { $0.artistName.lowercased() == name.lowercased() }) else { return }
        let entry = SupportEntry(
            id: UUID(),
            artistName: name,
            imageUrl: imageUrl,
            platforms: platforms.map { SavedPlatform(sourceId: $0.sourceId, url: $0.url) },
            dateAdded: Date()
        )
        entries.insert(entry, at: 0)
        saveEntries()
    }

    func toggleArtist(_ artist: ArtistResult) {
        if isArtistSaved(artist.name) {
            entries.removeAll { $0.artistName.lowercased() == artist.name.lowercased() }
        } else {
            let entry = SupportEntry(from: artist)
            entries.insert(entry, at: 0)
        }
        saveEntries()
    }

    func isRefreshing(_ entry: SupportEntry) -> Bool {
        refreshingEntryIds.contains(entry.id)
    }

    func refreshEntry(_ entry: SupportEntry) async {
        // Mark as refreshing
        refreshingEntryIds.insert(entry.id)

        do {
            // Fetch fresh data from API
            let (results, hasPendingEnrichment) = try await api.searchArtist(entry.artistName)

            // Find the matching artist result
            var matchingResult: ArtistResult? = results.first { result in
                result.name.lowercased() == entry.artistName.lowercased()
            }

            // If no exact match, use the first artist result
            if matchingResult == nil {
                matchingResult = results.first { $0.type == "artist" }
            }

            // Enrich with MusicBrainz data if available
            if hasPendingEnrichment, let mbData = try await api.fetchMusicBrainzData(entry.artistName) {
                let enrichedResults = await api.mergeWithMusicBrainzData(results: results, mbData: mbData)
                matchingResult = enrichedResults.first { result in
                    result.name.lowercased() == entry.artistName.lowercased()
                } ?? enrichedResults.first { $0.type == "artist" }
            }

            // Update the entry with new platforms
            if let artistResult = matchingResult {
                // Collect all platforms with URLs (verified + social)
                var allPlatforms: [SavedPlatform] = []
                for platform in artistResult.verifiedPlatforms {
                    if let url = platform.url {
                        allPlatforms.append(SavedPlatform(sourceId: platform.sourceId, url: url))
                    }
                }
                for platform in artistResult.socialPlatforms {
                    if let url = platform.url {
                        allPlatforms.append(SavedPlatform(sourceId: platform.sourceId, url: url))
                    }
                }

                let updatedEntry = SupportEntry(
                    id: entry.id,
                    artistName: entry.artistName,
                    imageUrl: artistResult.imageUrl ?? entry.imageUrl,
                    platforms: allPlatforms,
                    dateAdded: entry.dateAdded,
                    location: artistResult.location ?? entry.location
                )

                // Replace the entry in the array
                if let index = entries.firstIndex(where: { $0.id == entry.id }) {
                    entries[index] = updatedEntry
                    saveEntries()
                    print("[SupportListManager] Refreshed \(entry.artistName) with \(updatedEntry.platforms.count) platforms")
                }
            }
        } catch {
            print("[SupportListManager] Failed to refresh \(entry.artistName): \(error)")
        }

        // Remove from refreshing set
        refreshingEntryIds.remove(entry.id)
    }

    // MARK: - Entry Cap

    /// Trim entries to stay under the iCloud KVS size limit.
    /// Keeps the most recently added entries.
    private func enforceEntryCap() {
        guard entries.count > Self.maxEntries else { return }
        print("[SupportListManager] Warning: trimming \(entries.count) entries to \(Self.maxEntries)")
        // Sort by dateAdded descending, keep newest
        entries = Array(entries.sorted { $0.dateAdded > $1.dateAdded }.prefix(Self.maxEntries))
    }

    // MARK: - Persistence

    private func saveEntries() {
        enforceEntryCap()
        do {
            let data = try JSONEncoder().encode(entries)

            // Save to iCloud
            iCloudStore.set(data, forKey: storageKey)
            iCloudStore.synchronize()

            // Also save locally as fallback
            UserDefaults.standard.set(data, forKey: storageKey)
        } catch {
            print("[SupportListManager] Failed to save entries: \(error)")
        }
    }

    private func loadEntries() {
        // Try iCloud first
        if let data = iCloudStore.data(forKey: storageKey) {
            do {
                entries = try JSONDecoder().decode([SupportEntry].self, from: data)
                return
            } catch {
                print("[SupportListManager] Failed to decode iCloud data: \(error)")
            }
        }

        // Fall back to local storage
        if let data = UserDefaults.standard.data(forKey: storageKey) {
            do {
                entries = try JSONDecoder().decode([SupportEntry].self, from: data)
            } catch {
                print("[SupportListManager] Failed to decode local data: \(error)")
            }
        }
    }

    // MARK: - iCloud Sync

    private func setupiCloudObserver() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(iCloudDidUpdate),
            name: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: iCloudStore
        )

        // Start syncing
        iCloudStore.synchronize()
    }

    @objc private func iCloudDidUpdate(_ notification: Notification) {
        // Union merge: combine local and remote entries, keeping all unique artists
        Task { @MainActor in
            mergeWithiCloudData()
        }
    }

    /// Merge remote iCloud entries with local entries using union strategy.
    /// For the same artist (by name, case-insensitive), keep the entry with more platforms
    /// or the more recently added one.
    private func mergeWithiCloudData() {
        guard !isMerging else { return }
        isMerging = true
        defer { isMerging = false }

        guard let remoteData = iCloudStore.data(forKey: storageKey),
              let remoteEntries = try? JSONDecoder().decode([SupportEntry].self, from: remoteData) else {
            return
        }

        var merged: [String: SupportEntry] = [:]

        // Index local entries by lowercased artist name
        for entry in entries {
            let key = entry.artistName.lowercased()
            merged[key] = entry
        }

        // Merge remote entries
        for remoteEntry in remoteEntries {
            let key = remoteEntry.artistName.lowercased()
            if let existing = merged[key] {
                // Conflict: same artist exists locally and remotely
                // Keep the one with more platforms; if equal, keep the more recent one
                if remoteEntry.platforms.count > existing.platforms.count {
                    merged[key] = remoteEntry
                } else if remoteEntry.platforms.count == existing.platforms.count,
                          remoteEntry.dateAdded > existing.dateAdded {
                    merged[key] = remoteEntry
                }
                // Otherwise keep existing (local)
            } else {
                // New artist from remote -- add it
                merged[key] = remoteEntry
            }
        }

        // Sort by dateAdded descending (newest first)
        entries = merged.values.sorted { $0.dateAdded > $1.dateAdded }
        saveEntries()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
