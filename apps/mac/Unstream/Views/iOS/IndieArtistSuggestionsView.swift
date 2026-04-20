#if os(iOS)
import SwiftUI

struct IndieArtistSuggestionsView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var directory: IndieArtistDirectoryService

    private let columns = [
        GridItem(.flexible(), spacing: 16),
        GridItem(.flexible(), spacing: 16),
    ]

    var body: some View {
        Group {
            if directory.loadState == .failed && directory.artists.isEmpty {
                fallbackEmptyState
            } else if directory.artists.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 60)
            } else {
                gridContent
            }
        }
        .task(id: directory.sample.isEmpty) {
            await directory.loadIfNeeded()
        }
        .refreshable {
            await directory.refresh()
        }
    }

    private var gridContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            if isBandcampFriday() {
                BandcampFridayBadge()
                    .frame(maxWidth: .infinity, alignment: .center)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Discover indie artists")
                    .font(.title3)
                    .fontWeight(.semibold)
                Text("Tap any artist to find them on platforms that pay fairly")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 4)

            LazyVGrid(columns: columns, spacing: 20) {
                ForEach(directory.sample) { artist in
                    IndieArtistCard(artist: artist) {
                        appState.searchQuery = artist.name
                        Task { await appState.performSearch() }
                    }
                }
            }
        }
    }

    private var fallbackEmptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "music.note.house")
                .font(.system(size: 48))
                .foregroundColor(.secondary.opacity(0.5))

            Text("Search for an artist to find them\non ethical music platforms")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            if isBandcampFriday() {
                BandcampFridayBadge()
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 60)
    }
}

struct IndieArtistCard: View {
    let artist: IndieArtist
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 8) {
                avatar
                Text(artist.name)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundColor(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var avatar: some View {
        if let urlString = artist.imageUrl, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                case .empty, .failure:
                    placeholderCircle
                @unknown default:
                    placeholderCircle
                }
            }
            .frame(width: 140, height: 140)
            .clipShape(Circle())
        } else {
            placeholderCircle
        }
    }

    private var placeholderCircle: some View {
        ZStack {
            Circle()
                .fill(Color.secondary.opacity(0.15))
            Text(artist.name.prefix(1).uppercased())
                .font(.system(size: 44, weight: .semibold))
                .foregroundColor(.secondary)
        }
        .frame(width: 140, height: 140)
    }
}

private struct BandcampFridayBadge: View {
    var body: some View {
        let accent = Color(hex: "#1DA0C3") ?? .blue
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .foregroundColor(accent)
            Text("It's Bandcamp Friday!")
                .font(.subheadline)
                .fontWeight(.medium)
                .foregroundColor(accent)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(accent.opacity(0.1))
        .cornerRadius(8)
    }
}
#endif
