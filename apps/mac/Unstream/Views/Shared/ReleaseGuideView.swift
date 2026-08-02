import SwiftUI

#if os(macOS)
import AppKit
#endif

/// Which release a guide is for, plus what the alert already knew about it.
///
/// The title and artist name come along so the header can render the instant someone taps,
/// rather than flashing an empty box while the network answers.
struct ReleaseGuideTarget: Identifiable, Hashable {
    let artistName: String
    let releaseTitle: String
    let artistSlug: String
    let releaseSlug: String

    var id: String { "\(artistSlug)/\(releaseSlug)" }
}

extension NewRelease {
    /// Nil for an alert produced by the older per-platform scrape path, whose `releaseUrl` is a
    /// shop's rather than ours. Those releases aren't in the catalog, so there is no guide to
    /// show and the caller opens the link instead.
    var guideTarget: ReleaseGuideTarget? {
        guard let slugs = ReleaseDetailService.slugs(fromReleaseURL: releaseUrl) else { return nil }
        return ReleaseGuideTarget(
            artistName: artistName,
            releaseTitle: releaseName,
            artistSlug: slugs.artist,
            releaseSlug: slugs.release
        )
    }
}

/// How a nested view asks its container to show a release's buying guide.
///
/// The menu-bar popover has to drill down *in place* — it is a 320-point popover, not a window,
/// and opening a second window for this was explicitly ruled out — but the alert badge that
/// triggers it is several views down inside the saved-artists list. An environment action is the
/// plain way to bridge that without threading a closure through every view in between.
///
/// Nil means nobody is offering to present one, so the view falls back to opening the web page.
struct OpenReleaseGuideKey: EnvironmentKey {
    static let defaultValue: ((ReleaseGuideTarget) -> Void)? = nil
}

/// The same bridge, one level up: show an artist's catalogue. Set by the macOS popover, which
/// pushes it onto its own stack; iOS uses a NavigationLink and leaves this nil.
struct OpenArtistReleasesKey: EnvironmentKey {
    static let defaultValue: ((_ slug: String, _ name: String) -> Void)? = nil
}

extension EnvironmentValues {
    var openReleaseGuide: ((ReleaseGuideTarget) -> Void)? {
        get { self[OpenReleaseGuideKey.self] }
        set { self[OpenReleaseGuideKey.self] = newValue }
    }

    var openArtistReleases: ((String, String) -> Void)? {
        get { self[OpenArtistReleasesKey.self] }
        set { self[OpenArtistReleasesKey.self] = newValue }
    }
}

/// A release's buying guide, rendered in the app instead of in a browser tab.
///
/// The payout comparison is the product, and it matters most at the moment someone is deciding
/// where to buy. Sending that moment to `NSWorkspace.shared.open` handed it away — the same
/// mistake the old alerts made by linking straight to one shop.
///
/// Pure content, no chrome: the macOS popover wraps this in its own back header, iOS pushes or
/// presents it. That is what lets the same view fit a 320-point menu-bar popover and a phone.
struct ReleaseGuideView: View {
    let target: ReleaseGuideTarget

    @State private var detail: ReleaseDetail?
    @State private var loadState: LoadState = .loading
    #if os(iOS)
    @State private var safariItem: SafariURL?
    #endif

    private enum LoadState {
        case loading
        case loaded
        /// The release genuinely isn't catalogued.
        case notFound
        /// We couldn't get an answer — which is not the same thing, and never said as if it were.
        case unavailable
    }

    #if os(iOS)
    private let artworkSize: CGFloat = 96
    private let outerPadding: CGFloat = 16
    private let titleFont: Font = .title3.weight(.semibold)
    private let sourceNameFont: Font = .subheadline.weight(.semibold)
    private let formatFont: Font = .subheadline
    private let priceFont: Font = .subheadline.weight(.medium)
    private let formatColumnWidth: CGFloat = 84
    #else
    private let artworkSize: CGFloat = 60
    private let outerPadding: CGFloat = 12
    private let titleFont: Font = .headline
    private let sourceNameFont: Font = .caption.weight(.semibold)
    private let formatFont: Font = .caption
    private let priceFont: Font = .caption.weight(.medium)
    private let formatColumnWidth: CGFloat = 58
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header

                switch loadState {
                case .loading:
                    loadingRow
                case .loaded:
                    loadedBody
                case .notFound:
                    notice(
                        icon: "hourglass",
                        text: "We haven't catalogued this release yet. Opening it on Unstream will start that off."
                    )
                    openOnUnstreamLink
                case .unavailable:
                    notice(
                        icon: "wifi.exclamationmark",
                        text: "Couldn't load prices just now."
                    )
                    Button("Try Again") { Task { await load() } }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    openOnUnstreamLink
                }
            }
            .padding(outerPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: target.id) { await load() }
        #if os(iOS)
        .safariSheet(safariItem: $safariItem)
        #endif
    }

    // MARK: - Loading

    private func load() async {
        loadState = .loading
        do {
            detail = try await ReleaseDetailService.shared.fetch(
                artist: target.artistSlug,
                release: target.releaseSlug
            )
            loadState = .loaded
        } catch ReleaseDetailError.notFound {
            loadState = .notFound
        } catch {
            loadState = .unavailable
        }
    }

    private var loadingRow: some View {
        HStack(spacing: 8) {
            ProgressView().scaleEffect(0.6)
            Text("Checking where to buy…")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 8)
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            artwork

            VStack(alignment: .leading, spacing: 4) {
                Text(detail?.release.title ?? target.releaseTitle)
                    .font(titleFont)
                    .fixedSize(horizontal: false, vertical: true)

                Text(detail?.artist.name ?? target.artistName)
                    .font(.caption)
                    .foregroundColor(.secondary)

                HStack(spacing: 6) {
                    if detail?.isUpcoming == true {
                        Text("Upcoming")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                            .foregroundColor(.accentColor)
                    }
                    let dateText = ReleaseFormatting.date(
                        detail?.release.releaseDate,
                        precision: detail?.release.datePrecision
                    )
                    if !dateText.isEmpty {
                        Text(dateText).font(.caption2).foregroundColor(.secondary)
                    }
                }
            }
            .textSelection(.enabled)

            Spacer(minLength: 0)
        }
        .linkActions(
            url: URL(string: detail?.pageUrl ?? webPageURL),
            openTitle: "Open on Unstream",
            onOpen: { open(URL(string: detail?.pageUrl ?? webPageURL)) }
        )
    }

    private var artwork: some View {
        Group {
            if let urlString = detail?.release.artworkUrl, let url = URL(string: urlString) {
                AsyncImage(url: url) { image in
                    image.resizable().aspectRatio(contentMode: .fill)
                } placeholder: {
                    artworkPlaceholder
                }
            } else {
                artworkPlaceholder
            }
        }
        .frame(width: artworkSize, height: artworkSize)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var artworkPlaceholder: some View {
        Rectangle()
            .fill(Color.secondary.opacity(0.12))
            .overlay(Image(systemName: "music.note").foregroundColor(.secondary))
    }

    // MARK: - The guide itself

    @ViewBuilder
    private var loadedBody: some View {
        if let detail {
            if detail.bandcampFriday {
                bandcampFridayBanner
            }

            if detail.release.sources.isEmpty {
                // "We haven't looked yet" reads very differently from "you can't buy this", and
                // only the first is true here — coverage is demand-driven.
                notice(icon: "hourglass", text: "Still gathering formats and prices for this release.")
            } else {
                // Rendered in the order received. The server sorts sources artist-paying-first
                // and offers cheapest-buyable-first; re-sorting here would mean duplicating the
                // payout registry, which is the drift this whole endpoint exists to prevent.
                ForEach(detail.release.sources) { source in
                    sourceCard(source)
                }
            }

            footnote(detail)
        }
    }

    private var bandcampFridayBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "star.fill").foregroundColor(.orange)
            Text("Bandcamp Friday — Bandcamp is waiving its cut today.")
                .font(.caption2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.12)))
    }

    private func sourceCard(_ source: ReleaseDetailSource) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text(source.name).font(sourceNameFont)

                payoutPill(source)

                Spacer(minLength: 4)

                buyButton(source)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)

            if source.offers.isEmpty {
                Divider()
                Text(source.detailCheckedAt == nil
                     ? "Formats and prices not read yet"
                     : "No formats listed")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 7)
            } else {
                ForEach(Array(source.offers.enumerated()), id: \.element.id) { index, offer in
                    Divider().padding(.leading, index == 0 ? 0 : 10)
                    offerRow(offer, payoutPercent: source.payoutPercent)
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.15)))
        // The whole card carries the platform's URL, not just the small "Buy" text: a Mac user
        // right-clicks or drags the *thing*, and the thing here is "this release on Bandcamp".
        .linkActions(
            url: URL(string: source.url),
            openTitle: "Open on \(source.name)",
            onOpen: { open(URL(string: source.url)) }
        )
    }

    /// A platform with no published rate says so, rather than silently looking like one whose
    /// payout wasn't worth mentioning. Discogs is the live case: its listings are secondhand, so
    /// the artist genuinely receives nothing, and that is useful information rather than
    /// something to hide.
    @ViewBuilder
    private func payoutPill(_ source: ReleaseDetailSource) -> some View {
        if let percent = source.payoutPercent {
            Text("\(percent) to artist")
                .font(.caption2)
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(Capsule().fill(Color.green.opacity(0.15)))
                .foregroundColor(.green)
                .lineLimit(1)
        } else {
            Text("Payout unknown")
                .font(.caption2)
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(Capsule().fill(Color.secondary.opacity(0.12)))
                .foregroundColor(.secondary)
                .lineLimit(1)
        }
    }

    private func offerRow(_ offer: ReleaseDetailOffer, payoutPercent: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(ReleaseFormatting.label(forFormat: offer.format))
                .font(formatFont)
                .frame(width: formatColumnWidth, alignment: .leading)

            VStack(alignment: .leading, spacing: 1) {
                Text(ReleaseFormatting.price(offer.price, offer.currency))
                    .font(priceFont)
                    .foregroundColor(offer.isBuyable ? .primary : .secondary)

                // No payout line on something you can't buy. "≈$12 to artist" under a sold-out
                // cassette is a number about a transaction that cannot happen.
                if offer.isBuyable,
                   let payout = ReleaseFormatting.payout(offer.price, offer.currency, payoutPercent) {
                    Text(payout)
                        .font(.caption2)
                        .foregroundColor(.green)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 0)

            if let label = ReleaseFormatting.availabilityLabels[offer.availability] {
                Text(label)
                    .font(.caption2)
                    .foregroundColor(offer.availability == "sold_out" ? .secondary : .orange)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .opacity(offer.isBuyable ? 1 : 0.55)
        // A price is a fact someone may want to quote elsewhere; let them select it rather than
        // retype it. Selection sits on the row's text, so it doesn't fight the card's drag.
        .textSelection(.enabled)
    }

    // MARK: - Actions

    @ViewBuilder
    private func buyButton(_ source: ReleaseDetailSource) -> some View {
        if let url = URL(string: source.url) {
            Button { open(url) } label: {
                Text("Buy").font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .foregroundColor(.accentColor)
            .accessibilityLabel("Buy on \(source.name)")
            #if os(macOS)
            .help("Open \(source.name)")
            #endif
            .linkActions(url: url, openTitle: "Open on \(source.name)", onOpen: { open(url) })
        }
    }

    @ViewBuilder
    private var openOnUnstreamLink: some View {
        if let url = URL(string: detail?.pageUrl ?? webPageURL) {
            Button("Open on Unstream") { open(url) }
                .font(.caption)
                .buttonStyle(.plain)
                .foregroundColor(.accentColor)
                .linkActions(url: url, openTitle: "Open on Unstream", onOpen: { open(url) })
        }
    }

    /// Only used before a response arrives — once one has, `detail.pageUrl` is authoritative so
    /// the app and the site can't disagree about where a release lives.
    private var webPageURL: String {
        "https://unstream.stream/a/\(target.artistSlug)/\(target.releaseSlug)"
    }

    private func open(_ url: URL?) {
        guard let url else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        safariItem = SafariURL(url: url)
        #endif
    }

    // MARK: - Small pieces

    private func notice(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).foregroundColor(.secondary)
            Text(text)
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }

    private func footnote(_ detail: ReleaseDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            let freshness = ReleaseFormatting.freshness(detail.release.pricesCheckedAt)
            if !freshness.isEmpty {
                Text(freshness).font(.caption2).foregroundColor(.secondary)
            }

            Text("Payout estimates use each platform's published rates, before payment processing.")
                .font(.caption2)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            openOnUnstreamLink
        }
        .padding(.top, 2)
    }
}

#if os(iOS)
/// iOS presents the guide as a sheet from the saved-artists list, which needs its own dismiss.
struct ReleaseGuideSheet: View {
    let target: ReleaseGuideTarget
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ReleaseGuideView(target: target)
                .navigationTitle("Where to Buy")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}
#endif
