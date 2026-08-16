#if os(macOS)
import SwiftUI

/// Settings → Integrations section for the Apple Music library import
/// (support-loop-spec.md Step 2). Its own view rather than a computed property on
/// SettingsView because import progress needs @ObservedObject on the service, and
/// SettingsView holds its managers as plain optionals.
struct MusicLibrarySettingsSection: View {
    @ObservedObject var service: AppleMusicLibraryService

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
            Text("Reads your iCloud Music Library from the Music app — play counts, and whether each track is a file you own or an Apple Music subscription stream — so Unstream can show which artists you actually listen to and have never paid. The first import asks permission to control Music. Nothing is uploaded: this stays on your Mac.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
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
