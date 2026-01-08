import Foundation
import SwiftUI

@MainActor
class SupportListManager: ObservableObject {
    @Published private(set) var entries: [SupportEntry] = []
    @Published var searchQuery: String = ""

    var filteredEntries: [SupportEntry] {
        guard !searchQuery.isEmpty else { return entries }
        return entries.filter { entry in
            entry.artistName.localizedCaseInsensitiveContains(searchQuery)
        }
    }

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

    func toggleArtist(_ artist: ArtistResult) {
        if isArtistSaved(artist.name) {
            entries.removeAll { $0.artistName.lowercased() == artist.name.lowercased() }
        } else {
            let entry = SupportEntry(from: artist)
            entries.insert(entry, at: 0)
        }
        saveEntries()
    }

    // MARK: - Persistence

    private func saveEntries() {
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
        // Reload entries when iCloud data changes from another device
        Task { @MainActor in
            loadEntries()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
