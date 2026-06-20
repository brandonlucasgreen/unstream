import SwiftUI

/// Shows synced saved artists from the server (not the local-only SupportListManager).
/// Displayed in the menu bar popover's "Saved" section and on iOS.
struct SyncedArtistsView: View {
    @ObservedObject var sync = SavedArtistsSync.shared
    @ObservedObject var auth = AuthService.shared

    #if os(iOS)
    @State private var safariItem: SafariURL?
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !auth.isSignedIn {
                signedOutState
            } else if sync.syncedArtists.isEmpty {
                emptyState
            } else {
                artistList
            }
        }
        .task {
            if auth.isSignedIn {
                await sync.pull()
            }
        }
    }

    private var signedOutState: some View {
        VStack(spacing: 8) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.title2)
                .foregroundColor(.secondary)
            Text("Sign in to sync saved artists")
                .font(.caption)
                .foregroundColor(.secondary)
            Text("Your saved artists will appear here and stay in sync across devices.")
                .font(.caption2)
                .foregroundColor(.secondary.opacity(0.7))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            if sync.isSyncing {
                ProgressView()
                    .scaleEffect(0.8)
                Text("Syncing...")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                Image(systemName: "heart.slash")
                    .font(.title2)
                    .foregroundColor(.secondary)
                Text("No saved artists yet")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text("Save artists on unstream.stream and they'll appear here.")
                    .font(.caption2)
                    .foregroundColor(.secondary.opacity(0.7))
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }

    private var artistList: some View {
        VStack(spacing: 6) {
            if sync.isSyncing {
                HStack(spacing: 6) {
                    ProgressView()
                        .scaleEffect(0.6)
                    Text("Syncing...")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }

            ForEach(sync.syncedArtists) { artist in
                SyncedArtistRow(artist: artist) {
                    Task {
                        await sync.removeArtist(slug: artist.displaySlug)
                    }
                }
            }
        }
    }
}

struct SyncedArtistRow: View {
    let artist: SyncedArtist
    let onRemove: () -> Void

    #if os(iOS)
    @State private var safariItem: SafariURL?
    #endif

    var body: some View {
        HStack(spacing: 10) {
            // Artist image
            if let imageUrl = artist.imageUrl, let url = URL(string: imageUrl) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    default:
                        Image(systemName: "person.circle.fill")
                            .resizable()
                            .foregroundColor(.secondary.opacity(0.5))
                    }
                }
                .frame(width: 28, height: 28)
                .clipShape(Circle())
            } else {
                Image(systemName: "person.circle.fill")
                    .resizable()
                    .foregroundColor(.secondary.opacity(0.5))
                    .frame(width: 28, height: 28)
            }

            // Name + claimed badge
            VStack(alignment: .leading, spacing: 2) {
                Text(artist.name)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)

                if artist.claimed == true {
                    Text("Verified")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(.green)
                }
            }

            Spacer()

            // Open artist page
            if let profileURL = artist.profileURL {
                Button(action: { openURL(profileURL) }) {
                    Image(systemName: "arrow.up.right.square")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                #if os(macOS)
                .help("Open artist page")
                #endif
            }

            // Remove
            Button(action: onRemove) {
                Image(systemName: "heart.slash")
                    .font(.system(size: 12))
                    .foregroundColor(.red.opacity(0.7))
            }
            .buttonStyle(.plain)
            #if os(macOS)
            .help("Remove from saved")
            #endif
        }
        .padding(.vertical, 4)
        #if os(iOS)
        .safariSheet(safariItem: $safariItem)
        #endif
    }

    private func openURL(_ url: URL) {
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        safariItem = SafariURL(url: url)
        #endif
    }
}
