import SwiftUI

struct SupportListView: View {
    @ObservedObject var supportListManager: SupportListManager

    private var isSearching: Bool {
        !supportListManager.searchQuery.isEmpty
    }

    private var countText: String {
        let total = supportListManager.entries.count
        let filtered = supportListManager.filteredEntries.count

        if isSearching {
            return "\(filtered) of \(total) artist\(total == 1 ? "" : "s")"
        } else {
            return "\(total) artist\(total == 1 ? "" : "s")"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Saved Artists")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .textCase(.uppercase)

                Spacer()

                Text(countText)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            // Search bar
            if supportListManager.entries.count > 0 {
                SavedArtistsSearchBar(supportListManager: supportListManager)
            }

            if supportListManager.entries.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "heart.slash")
                        .font(.title2)
                        .foregroundColor(.secondary)
                    Text("No artists saved yet")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("Search for artists and tap the heart to add them here.")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.7))
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 20)
            } else if supportListManager.filteredEntries.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.title2)
                        .foregroundColor(.secondary)
                    Text("No matches found")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("Try a different search term.")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.7))
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 20)
            } else {
                ForEach(supportListManager.filteredEntries) { entry in
                    SupportEntryView(entry: entry) {
                        supportListManager.removeEntry(entry)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SavedArtistsSearchBar: View {
    @ObservedObject var supportListManager: SupportListManager

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)
                .font(.system(size: 14))

            TextField("Filter saved artists...", text: $supportListManager.searchQuery)
                .textFieldStyle(.plain)
                .font(.system(size: 14))

            if !supportListManager.searchQuery.isEmpty {
                Button(action: {
                    supportListManager.clearSearch()
                }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                        .font(.system(size: 14))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(NSColor.textBackgroundColor))
        .cornerRadius(8)
    }
}

struct SupportEntryView: View {
    let entry: SupportEntry
    let onRemove: () -> Void

    @State private var isHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(entry.artistName)
                    .font(.system(size: 14, weight: .semibold))

                Spacer()

                Button(action: onRemove) {
                    Image(systemName: "heart.fill")
                        .foregroundColor(.red)
                        .font(.system(size: 14))
                }
                .buttonStyle(.plain)
                .opacity(isHovering ? 1 : 0.5)
                .help("Remove from Saved Artists")
            }

            if !entry.platforms.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(entry.platforms) { platform in
                        SavedPlatformBadge(platform: platform)
                    }
                }
            }

            // Added date
            Text("Added \(entry.dateAdded.formatted(.relative(presentation: .named)))")
                .font(.caption2)
                .foregroundColor(.secondary.opacity(0.7))
        }
        .padding(10)
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(8)
        .onHover { hovering in
            isHovering = hovering
        }
    }
}

struct SavedPlatformBadge: View {
    let platform: SavedPlatform

    var body: some View {
        Button(action: openURL) {
            HStack(spacing: 4) {
                Image(systemName: platform.icon)
                    .font(.system(size: 10))
                Text(platform.displayName)
                    .font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background((Color(hex: platform.color) ?? .blue).opacity(0.15))
            .foregroundColor(Color(hex: platform.color) ?? .blue)
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
        .help("Open \(platform.displayName)")
    }

    private func openURL() {
        guard let url = URL(string: platform.url) else { return }
        NSWorkspace.shared.open(url)
    }
}

#Preview {
    SupportListView(supportListManager: SupportListManager())
        .padding()
        .frame(width: 300)
}
