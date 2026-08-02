import SwiftUI

// A release's buying guide, rendered natively instead of opening unstream.stream.
//
// The whole point of the Releases feature is the payout comparison at the moment someone decides
// where to buy. Handing that moment to a browser tab is the same mistake the old alerts made when
// they linked straight to one shop — the comparison is the product, so it should be in the app.
//
// Everything here is computed from data the client already has: offers come from the release
// payload, and payout percentages come from `platformCatalog`, which already carries them for the
// search UI. No new maths lives on the server.

// MARK: - Models

/// One buyable thing: a format at a price on a platform.
struct ReleaseOffer: Codable, Hashable, Identifiable {
    let format: String
    let price: Double?
    let currency: String?
    let availability: String

    var id: String { "\(format)-\(price ?? -1)-\(currency ?? "")" }

    var isBuyable: Bool { availability != "sold_out" }
}

struct ReleaseSource: Codable, Hashable, Identifiable {
    let platform: String
    let url: String
    let offers: [ReleaseOffer]

    var id: String { platform }
    var displayName: String { platformCatalog[platform]?.name ?? platform.capitalized }
    var payoutPercent: String? { platformCatalog[platform]?.artistPayoutPercent }
}

struct ReleaseSummary: Codable, Hashable, Identifiable {
    let slug: String
    let title: String
    let releaseType: String
    let releaseDate: String?
    let datePrecision: String?
    let status: String
    let artworkUrl: String?
    let sources: [ReleaseSource]

    var id: String { slug }
    var isUpcoming: Bool { status == "announced" }
}

// MARK: - Formatting
//
// Mirrors api/shared/release-display.ts. Kept deliberately small and in one place: these are
// claims about someone's income, so the rules (ranges never point estimates, zero means
// name-your-price, two decimals or none) must not drift between the web and the app.

enum ReleaseFormatting {
    static let formatLabels: [String: String] = [
        "digital": "Digital", "vinyl": "Vinyl", "cassette": "Cassette",
        "cd": "CD", "book": "Book", "merch": "Merch", "other": "Other",
    ]

    static let availabilityLabels: [String: String] = [
        "preorder": "Pre-order", "sold_out": "Sold out", "unknown": "Price unknown",
    ]

    /// Sold-out and unpriced options sink; something you can buy floats.
    static let availabilityRank: [String: Int] = [
        "available": 0, "preorder": 1, "unknown": 2, "sold_out": 3,
    ]

    static func label(forFormat format: String) -> String {
        formatLabels[format] ?? format.capitalized
    }

    /// Two decimals or none — never one. "$8.50", never "$8.5"; "$25", never "$25.00".
    static func money(_ amount: Double, _ currency: String?) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = currency ?? "USD"
        f.locale = Locale(identifier: "en_US")
        let whole = amount.rounded() == amount
        f.minimumFractionDigits = whole ? 0 : 2
        f.maximumFractionDigits = whole ? 0 : 2
        return f.string(from: NSNumber(value: amount)) ?? "\(amount) \(currency ?? "")"
    }

    /// **Zero means name-your-price, not free.** Telling a fan a record costs nothing when they
    /// are being invited to decide what to pay is close to the opposite of this product's point.
    static func price(_ price: Double?, _ currency: String?) -> String {
        guard let price else { return "—" }
        if price == 0 { return "Name your price" }
        return money(price, currency)
    }

    /// "≈$7.20–$7.65 to artist" — always a range, because the registry's payout figures are
    /// ranges and they are honest about it. Returns nil rather than inventing precision.
    static func payout(_ price: Double?, _ currency: String?, _ payoutPercent: String?) -> String? {
        guard let price, price > 0, let payoutPercent else { return nil }

        let numbers = payoutPercent
            .components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted)
            .filter { !$0.isEmpty }
            .compactMap(Double.init)
        guard let first = numbers.first, let last = numbers.last else { return nil }

        let low = money(price * first / 100, currency)
        let high = money(price * last / 100, currency)
        return low == high ? "≈\(low) to artist" : "≈\(low)–\(high) to artist"
    }

    /// A date rendered only as precisely as we actually know it. A year-only date must not print
    /// as "1 January" — that states a fact no source gave us.
    static func date(_ iso: String?, precision: String?) -> String {
        guard let iso, let year = Int(iso.prefix(4)) else { return "" }
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        if precision == "year" { return String(year) }

        var comps = DateComponents()
        comps.year = year
        comps.month = parts.count > 1 ? parts[1] : 1
        comps.day = parts.count > 2 ? parts[2] : 1
        guard let d = Calendar(identifier: .gregorian).date(from: comps) else { return String(year) }

        let f = DateFormatter()
        f.dateFormat = precision == "month" ? "MMMM yyyy" : "d MMMM yyyy"
        if precision == "day" || precision == "month" { return f.string(from: d) }
        return ""
    }

    /// Artist-paying options lead, always. A page that put "used CD $2.64" above "vinyl direct
    /// from the artist $30" would be off-mission even though both facts are true.
    static func payoutRank(_ platform: String) -> Double {
        guard let percent = platformCatalog[platform]?.artistPayoutPercent else { return -1 }
        let numbers = percent
            .components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted)
            .filter { !$0.isEmpty }
            .compactMap(Double.init)
        return numbers.first ?? -1
    }

    static func ordered(_ sources: [ReleaseSource]) -> [ReleaseSource] {
        sources.sorted { payoutRank($0.platform) > payoutRank($1.platform) }
    }

    static func ordered(_ offers: [ReleaseOffer]) -> [ReleaseOffer] {
        offers.sorted { a, b in
            let ra = availabilityRank[a.availability] ?? 9
            let rb = availabilityRank[b.availability] ?? 9
            if ra != rb { return ra < rb }
            return (a.price ?? .greatestFiniteMagnitude) < (b.price ?? .greatestFiniteMagnitude)
        }
    }
}

// MARK: - View

struct ReleaseSummaryView: View {
    let artistName: String
    let release: ReleaseSummary
    /// Where "Open on Unstream" goes. Kept as an escape hatch, not the primary action.
    let webURL: URL?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header

                if release.sources.isEmpty {
                    // "We haven't looked yet" reads very differently from "you can't buy this",
                    // and only the first is true here — coverage is demand-driven.
                    HStack(spacing: 8) {
                        Image(systemName: "hourglass").foregroundColor(.secondary)
                        Text("Still gathering formats and prices for this release.")
                            .font(.footnote).foregroundColor(.secondary)
                    }
                    .padding(.vertical, 8)
                } else {
                    ForEach(ReleaseFormatting.ordered(release.sources)) { source in
                        sourceCard(source)
                    }
                }

                footnote
            }
            .padding(20)
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            artwork

            VStack(alignment: .leading, spacing: 6) {
                Text(release.title)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)

                Text(artistName)
                    .font(.subheadline)
                    .foregroundColor(.secondary)

                HStack(spacing: 6) {
                    if release.isUpcoming {
                        Text("Upcoming")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                            .foregroundColor(.accentColor)
                    }
                    let dateText = ReleaseFormatting.date(release.releaseDate, precision: release.datePrecision)
                    if !dateText.isEmpty {
                        Text(dateText).font(.caption).foregroundColor(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var artwork: some View {
        Group {
            if let urlString = release.artworkUrl, let url = URL(string: urlString) {
                AsyncImage(url: url) { image in
                    image.resizable().aspectRatio(contentMode: .fill)
                } placeholder: {
                    Rectangle().fill(Color.secondary.opacity(0.12))
                }
            } else {
                Rectangle().fill(Color.secondary.opacity(0.12))
                    .overlay(Image(systemName: "music.note").foregroundColor(.secondary))
            }
        }
        .frame(width: 88, height: 88)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: One platform's offers

    private func sourceCard(_ source: ReleaseSource) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(source.displayName).font(.subheadline.weight(.semibold))
                // A platform with no published rate says so, rather than silently looking like
                // one that pays nothing — or, worse, like one whose payout simply wasn't worth
                // mentioning. Discogs is the live case: its listings are secondhand, so the
                // artist genuinely receives nothing, and that is useful information rather than
                // something to hide (spec §10).
                if let percent = source.payoutPercent {
                    Text("\(percent) to artist")
                        .font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Color.green.opacity(0.15)))
                        .foregroundColor(.green)
                } else {
                    Text("Payout unknown")
                        .font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Color.secondary.opacity(0.12)))
                        .foregroundColor(.secondary)
                }
                Spacer()
                if let url = URL(string: source.url) {
                    Link("Buy", destination: url).font(.caption.weight(.semibold))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)

            Divider()

            ForEach(Array(ReleaseFormatting.ordered(source.offers).enumerated()), id: \.element.id) { index, offer in
                if index > 0 { Divider().padding(.leading, 12) }
                offerRow(offer, payoutPercent: source.payoutPercent)
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.15)))
    }

    private func offerRow(_ offer: ReleaseOffer, payoutPercent: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(ReleaseFormatting.label(forFormat: offer.format))
                .font(.callout)
                .frame(width: 74, alignment: .leading)

            VStack(alignment: .leading, spacing: 2) {
                Text(ReleaseFormatting.price(offer.price, offer.currency))
                    .font(.callout.weight(.medium))
                    .foregroundColor(offer.isBuyable ? .primary : .secondary)

                // No payout line on something you can't buy. "≈$12 to artist" under a sold-out
                // cassette is a number about a transaction that cannot happen.
                if offer.isBuyable,
                   let payout = ReleaseFormatting.payout(offer.price, offer.currency, payoutPercent) {
                    Text(payout).font(.caption2).foregroundColor(.green)
                }
            }

            Spacer(minLength: 0)

            if let label = ReleaseFormatting.availabilityLabels[offer.availability] {
                Text(label)
                    .font(.caption2)
                    .foregroundColor(offer.availability == "sold_out" ? .secondary : .orange)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .opacity(offer.isBuyable ? 1 : 0.55)
    }

    // MARK: Footnote

    private var footnote: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Payouts are estimates based on each platform's published rates, before payment processing.")
                .font(.caption2)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let webURL {
                Link("Open on Unstream", destination: webURL).font(.caption)
            }
        }
    }
}
