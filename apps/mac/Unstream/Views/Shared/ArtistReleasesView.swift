import SwiftUI

#if os(macOS)
import AppKit
#endif

/// An artist's releases, with the price line that makes one worth opening.
///
/// The step that was missing: searching an artist showed their platform links and stopped there,
/// so a fan had no route from "I found them" to "here's what their records cost and who gets the
/// money". Tapping a release opens `ReleaseGuideView`.
///
/// Pure content, no chrome — the macOS popover wraps it in a back header, iOS pushes it. Same
/// arrangement as `ReleaseGuideView`, which is what lets both fit a 320-point popover.
struct ArtistReleasesView: View {
    let slug: String
    /// What search already knew, so the header renders before the network answers.
    let fallbackName: String

    /// How to open one release. The macOS popover pushes another level onto its own stack; iOS
    /// hands back a navigation destination.
    let onOpenRelease: (ReleaseGuideTarget) -> Void

    @State private var page: ArtistPage?
    @State private var loadState: LoadState = .loading
    #if os(iOS)
    @State private var safariItem: SafariURL?
    #endif

    private enum LoadState {
        case loading
        case loaded
        /// No page for this artist. A real answer.
        case notFound
        /// We couldn't get an answer — not the same thing.
        case unavailable
    }

    #if os(iOS)
    private let artworkSize: CGFloat = 52
    private let outerPadding: CGFloat = 16
    private let nameFont: Font = .title3.weight(.semibold)
    private let titleFont: Font = .subheadline.weight(.medium)
    private let metaFont: Font = .caption
    #else
    private let artworkSize: CGFloat = 36
    private let outerPadding: CGFloat = 12
    private let nameFont: Font = .headline
    private let titleFont: Font = .caption.weight(.medium)
    private let metaFont: Font = .caption2
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header

                switch loadState {
                case .loading:
                    HStack(spacing: 8) {
                        ProgressView().scaleEffect(0.6)
                        Text("Loading releases…").font(.caption).foregroundColor(.secondary)
                    }
                    .padding(.vertical, 8)

                case .loaded:
                    loadedBody

                case .notFound:
                    notice("We don't have a page for this artist yet.")
                    openOnUnstreamLink

                case .unavailable:
                    notice("Couldn't load releases just now.")
                    Button("Try Again") { Task { await load() } }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    openOnUnstreamLink
                }
            }
            .padding(outerPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: slug) { await load() }
        #if os(iOS)
        .safariSheet(safariItem: $safariItem)
        #endif
    }

    private func load() async {
        loadState = .loading
        do {
            page = try await ReleaseDetailService.shared.fetchArtistPage(slug: slug)
            loadState = .loaded
        } catch ReleaseDetailError.notFound {
            loadState = .notFound
        } catch {
            loadState = .unavailable
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Group {
                if let urlString = page?.artist.imageUrl, let url = URL(string: urlString) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        Circle().fill(Color.secondary.opacity(0.12))
                    }
                } else {
                    Circle().fill(Color.secondary.opacity(0.12))
                        .overlay(Image(systemName: "person.fill").foregroundColor(.secondary))
                }
            }
            .frame(width: artworkSize, height: artworkSize)
            .clipShape(Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(page?.artist.name ?? fallbackName)
                    .font(nameFont)
                    .fixedSize(horizontal: false, vertical: true)

                if let location = page?.artist.locationText {
                    Text(location).font(metaFont).foregroundColor(.secondary)
                }
            }
            .textSelection(.enabled)

            Spacer(minLength: 0)
        }
    }

    // MARK: - Releases

    @ViewBuilder
    private var loadedBody: some View {
        if let page {
            if page.releases.isEmpty {
                // Coverage is demand-driven, so an empty catalogue usually means "not looked at
                // yet" rather than "this artist has released nothing" — don't say the second.
                notice("No releases catalogued for this artist yet.")
            } else {
                Text(releaseCountLabel(page))
                    .font(.caption2.weight(.semibold))
                    .foregroundColor(.secondary)

                VStack(spacing: 6) {
                    ForEach(page.releases) { release in
                        releaseRow(release, artistName: page.artist.name)
                    }
                }

                // The list is capped at 60 by the endpoint. Say when there are more rather than
                // letting the list imply it is the whole catalogue.
                if page.totalReleases > page.releases.count {
                    Text("Showing \(page.releases.count) of \(page.totalReleases). Open the full page for the rest.")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            openOnUnstreamLink
        }
    }

    private func releaseCountLabel(_ page: ArtistPage) -> String {
        let count = page.totalReleases
        return count == 1 ? "1 RELEASE" : "\(count) RELEASES"
    }

    private func releaseRow(_ release: ArtistRelease, artistName: String) -> some View {
        Button {
            onOpenRelease(ReleaseGuideTarget(
                artistName: artistName,
                releaseTitle: release.title,
                artistSlug: slug,
                releaseSlug: release.slug
            ))
        } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(release.title)
                        .font(titleFont)
                        .foregroundColor(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 5) {
                        if release.isUpcoming {
                            Text("Upcoming")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                                .foregroundColor(.accentColor)
                        }

                        // Price first when we have one — it is the reason to open the guide.
                        // Otherwise the date, which at least says what this is.
                        let summary = release.offerSummary ?? ""
                        if !summary.isEmpty {
                            Text(summary).font(.caption2).foregroundColor(.green)
                        } else {
                            let dateText = ReleaseFormatting.date(release.releaseDate, precision: release.datePrecision)
                            if !dateText.isEmpty {
                                Text(dateText).font(.caption2).foregroundColor(.secondary)
                            }
                        }
                    }
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.07)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(release.title). Show where to buy.")
        #if os(macOS)
        .help("Where to buy \(release.title)")
        #endif
    }

    // MARK: - Small pieces

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 4)
    }

    /// The bio, links, dividers and featured embed all live on the web page. This view is
    /// deliberately just the catalogue, so the way to the rest of it is a link rather than a
    /// second, thinner copy of that page.
    @ViewBuilder
    private var openOnUnstreamLink: some View {
        if let url = URL(string: "https://unstream.stream/a/\(slug)") {
            Button("Open full page on Unstream") { open(url) }
                .font(.caption)
                .buttonStyle(.plain)
                .foregroundColor(.accentColor)
                .padding(.top, 2)
        }
    }

    private func open(_ url: URL) {
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        safariItem = SafariURL(url: url)
        #endif
    }
}
