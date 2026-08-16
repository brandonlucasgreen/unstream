#if os(macOS)
import SwiftUI

/// Settings → Integrations section for the Apple Music library import
/// (support-loop-spec.md Step 2). Its own view rather than a computed property on
/// SettingsView because import progress needs @ObservedObject on the service, and
/// SettingsView holds its managers as plain optionals.
struct MusicLibrarySettingsSection: View {
    @ObservedObject var service: AppleMusicLibraryService
    @ObservedObject private var auth = AuthService.shared

    private var isSignedIn: Bool { auth.isSignedIn }

    var body: some View {
        Section {
            if let snapshot = service.snapshot {
                LabeledContent("Imported") {
                    Text(summaryLine(for: snapshot))
                        .foregroundColor(.secondary)
                }

                LabeledContent("Last imported") {
                    Text(snapshot.importedAt.formatted(.relative(presentation: .named)))
                        .foregroundColor(.secondary)
                }

                LabeledContent("Synced to your account") {
                    if let syncedAt = service.lastSyncedAt {
                        Text(syncedAt.formatted(.relative(presentation: .named)))
                            .foregroundColor(.secondary)
                    } else {
                        Text(isSignedIn ? "Not yet — re-import to sync" : "No — you're signed out")
                            .foregroundColor(.secondary)
                    }
                }
            }

            HStack {
                Button(service.snapshot == nil ? "Import Library" : "Re-import Library") {
                    Task { await service.importLibrary() }
                }
                .disabled(service.isImporting)
                .help("Read your Music library, including play counts and owned-vs-streamed status")

                if service.isImporting {
                    ProgressView()
                        .controlSize(.small)
                    Text("Reading your library…")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Spacer()

                if service.snapshot != nil {
                    Button("Forget Imported Data") {
                        service.clearSnapshot()
                    }
                    .disabled(service.isImporting)
                    .help("Delete the imported library data from this Mac")
                }
            }

            if let error = service.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
            }

            if let syncError = service.syncError {
                Text(syncError)
                    .font(.caption)
                    .foregroundColor(.red)
            }
        } header: {
            HStack {
                Text("iCloud Music Library")
                if service.snapshot != nil {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                        .font(.caption)
                        .accessibilityLabel("iCloud Music Library imported")
                }
            }
        } footer: {
            Text(privacyFooter)
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    /// The privacy claim has to track what is actually true right now, not the general case:
    /// signed out this really is local-only, and signed in it really isn't.
    private var privacyFooter: String {
        let base = "Reads your iCloud Music Library from the Music app — play counts, and whether each track is a file you own or an Apple Music subscription stream — so Unstream can show which artists you actually listen to and have never paid. The first import asks permission to control Music."
        if isSignedIn {
            return base + " Because you're signed in, the artist names and play counts are synced to your Unstream account so the same list works on the web. Nothing else is uploaded, and none of it is ever public."
        }
        return base + " You're signed out, so this stays on your Mac — sign in if you want the same list on the web."
    }

    private func summaryLine(for snapshot: LibrarySnapshot) -> String {
        var parts = ["\(snapshot.trackTotal.formatted()) tracks"]
        if snapshot.ownedTotal > 0 {
            parts.append("\(snapshot.ownedTotal.formatted()) you own")
        }
        if snapshot.subscriptionTotal > 0 {
            parts.append("\(snapshot.subscriptionTotal.formatted()) subscription-only")
        }
        parts.append("\(snapshot.artists.count.formatted()) artists")
        return parts.joined(separator: " · ")
    }
}
#endif
