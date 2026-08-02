import Foundation

// One release's buying guide, as served by GET /api/release/{artist}/{release}.
//
// The payout comparison is the whole point of the Releases feature, and until now both clients
// handed that moment to a browser tab. These types are what let the app show it itself.
//
// **Payout percentages come off the wire, never out of `platformCatalog`.** The registry figures
// are duplicated by hand across eight files in this repo, and that drift is what let the Discord
// bot quote an unsourced rate for Jam.coop for months. A client that reads the number the server
// computed cannot drift — and it also gets the Bandcamp Friday override (~97%), which no client
// knows exists.

/// One buyable thing: a format, at a price, in a state of availability.
struct ReleaseDetailOffer: Codable, Hashable, Identifiable {
    let format: String
    let price: Double?
    let currency: String?
    let availability: String
    let capturedAt: String?

    var id: String {
        let priceKey = price.map { String($0) } ?? "none"
        return "\(format)-\(priceKey)-\(currency ?? "")-\(availability)"
    }

    /// Sold out is the only state that means "you cannot give this artist money right now".
    /// `unknown` still gets a Buy button, because the platform page may well sell it.
    var isBuyable: Bool { availability != "sold_out" }
}

/// One platform selling the release.
struct ReleaseDetailSource: Codable, Hashable, Identifiable {
    let platform: String
    /// The platform's proper display name, from the server's registry — "Jam.coop", not "Jamcoop".
    let name: String
    let url: String
    /// A range like "80-85%", or nil for a platform with no published rate (Discogs listings are
    /// secondhand, so the artist genuinely receives nothing — worth saying, not worth hiding).
    let payoutPercent: String?
    /// True while Bandcamp is waiving its revenue share, which makes `payoutPercent` ~97%.
    let bandcampFriday: Bool
    /// When this platform's page was last read for prices. Null means never — which is not the
    /// same as "it sells nothing", and the UI has to keep those apart.
    let detailCheckedAt: String?
    let offers: [ReleaseDetailOffer]

    var id: String { platform }
}

struct ReleaseDetailRelease: Codable, Hashable {
    let slug: String
    let title: String
    let releaseType: String
    let releaseDate: String?
    let datePrecision: String?
    let status: String
    let artworkUrl: String?
    /// The oldest price across every source — the honest freshness claim, ISO-8601.
    let pricesCheckedAt: String?
    /// Already ordered artist-paying-first by the server, and each source's offers already
    /// ordered buyable-and-cheapest-first. **Do not re-sort.** Ordering needs the payout
    /// registry, and duplicating that here is exactly the drift these types exist to avoid.
    let sources: [ReleaseDetailSource]
}

struct ReleaseDetailArtist: Codable, Hashable {
    let slug: String
    let name: String
    let imageUrl: String?
}

struct ReleaseDetail: Codable, Hashable {
    let artist: ReleaseDetailArtist
    let release: ReleaseDetailRelease
    /// The web release page for this record, for the "Open on Unstream" escape hatch. Taken from
    /// the response rather than rebuilt, so the two surfaces stay tied together if it ever changes.
    let pageUrl: String
    let bandcampFriday: Bool

    var isUpcoming: Bool { release.status == "announced" }
}

// MARK: - Formatting
//
// Mirrors api/shared/release-display.ts. Deliberately small and in one place: every function here
// makes a claim about someone's money or a release date, so the rules must not drift between the
// web page and the app. `UnstreamTests/ReleaseDetailTests.swift` pins each of them.

enum ReleaseFormatting {
    static let formatLabels: [String: String] = [
        "digital": "Digital", "vinyl": "Vinyl", "cassette": "Cassette",
        "cd": "CD", "book": "Book", "merch": "Merch", "other": "Other",
    ]

    /// Only the states worth saying out loud — "available" needs no label beside a price.
    static let availabilityLabels: [String: String] = [
        "preorder": "Pre-order", "sold_out": "Sold out", "unknown": "Price unknown",
    ]

    static func label(forFormat format: String) -> String {
        formatLabels[format] ?? format.capitalized
    }

    /// Money, in the currency the platform quoted.
    ///
    /// Two decimals or none — never one. "$25", never "$25.00"; "$8.50", never "$8.5", which
    /// looks like a typo in a price. Cents are never rounded away: tidying someone's money is a
    /// small lie in an app whose entire job is being accurate about it.
    ///
    /// `en_US` rather than the user's locale, deliberately. This is the one place where matching
    /// the web page matters more than feeling native — the endpoint exists so a native client
    /// can never describe a release differently from the page a fan would see for it, and the
    /// page formats with `Intl.NumberFormat('en-US', …)`.
    static func money(_ amount: Double, _ currency: String?) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency ?? "USD"
        formatter.locale = Locale(identifier: "en_US")
        let isWhole = amount.rounded() == amount
        formatter.minimumFractionDigits = isWhole ? 0 : 2
        formatter.maximumFractionDigits = isWhole ? 0 : 2
        return formatter.string(from: NSNumber(value: amount)) ?? "\(amount) \(currency ?? "")"
    }

    /// What goes in the price column.
    ///
    /// **Zero means name-your-price, not free.** Bandcamp reports a name-your-price release as
    /// `price: 0` with no other signal, and rendering that as "$0" tells a fan the record costs
    /// nothing — when they are in fact being invited to decide what to pay, which in an app about
    /// paying artists is close to the opposite message. Caught on Kid Lightbulbs' own catalog,
    /// where every release is name-your-price.
    ///
    /// A nil price is a format we know exists but have no figure for; an em dash says that
    /// without claiming it's free.
    static func price(_ price: Double?, _ currency: String?) -> String {
        guard let price else { return "—" }
        if price == 0 { return "Name your price" }
        return money(price, currency)
    }

    /// "≈$4–$4.25 to artist" — the emotional payload of the whole product, at the moment someone
    /// is deciding where to buy.
    ///
    /// Deliberately a **range**, because the payout figures are ranges and they are honest about
    /// it: Bandcamp's real take differs between digital and physical, payment processing comes off
    /// the top, and on a Bandcamp Friday it's ~97%. Asserting a single precise figure about
    /// someone's income would be worse than saying "roughly". Returns nil rather than inventing
    /// either a percentage or a price.
    static func payout(_ price: Double?, _ currency: String?, _ payoutPercent: String?) -> String? {
        guard let price, price > 0, let payoutPercent else { return nil }

        let numbers = payoutPercent
            .components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted)
            .filter { !$0.isEmpty }
            .compactMap(Double.init)
        guard let low = numbers.first, let high = numbers.last else { return nil }

        let lowAmount = money(price * low / 100, currency)
        let highAmount = money(price * high / 100, currency)
        return lowAmount == highAmount
            ? "≈\(lowAmount) to artist"
            : "≈\(lowAmount)–\(highAmount) to artist"
    }

    /// A release date rendered only as precisely as we actually know it.
    ///
    /// MusicBrainz returns year-only and month-only dates, and printing "1 January 2023" for a
    /// year-only date states a fact no source ever gave us. `datePrecision` exists for this.
    ///
    /// Unlike money, the *shape* of a date is safe to localize — "23 October 2025" and
    /// "October 23, 2025" are the same claim — so the template follows the user's locale.
    static func date(_ iso: String?, precision: String?) -> String {
        guard let iso, let year = Int(iso.prefix(4)) else { return "" }
        if precision == "year" { return String(year) }
        guard precision == "month" || precision == "day" else {
            // 'unknown' precision on a stored date means we padded it ourselves. Say nothing
            // rather than pick a shape.
            return ""
        }

        let parts = iso.split(separator: "-").compactMap { Int($0) }
        var components = DateComponents()
        components.year = year
        components.month = parts.count > 1 ? parts[1] : 1
        components.day = parts.count > 2 ? parts[2] : 1
        guard let date = Calendar(identifier: .gregorian).date(from: components) else {
            return String(year)
        }

        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate(precision == "month" ? "MMMMy" : "dMMMMy")
        return formatter.string(from: date)
    }

    /// "checked today" / "checked 3 days ago" — how old a price is, in words a person reads.
    /// Empty when we've never read prices, so the caller can say that instead of implying zero.
    ///
    /// Whole elapsed 24-hour periods, matching `relativeDays` in api/shared/release-display.ts
    /// exactly. Deliberately not `Calendar.dateComponents([.day])`, which counts in the user's
    /// local calendar: a price captured at 23:00 UTC would read "yesterday" to a fan in one
    /// timezone and "today" to a fan in another, for the same release at the same moment.
    static func freshness(_ iso: String?, now: Date = Date()) -> String {
        guard let iso, let captured = isoDate(iso) else { return "" }
        let days = Int(floor(now.timeIntervalSince(captured) / 86_400))
        if days < 0 { return "Prices checked just now" }
        if days == 0 { return "Prices checked today" }
        if days == 1 { return "Prices checked yesterday" }
        return "Prices checked \(days) days ago"
    }

    /// The API sends fractional seconds on some timestamps and not others, and
    /// `ISO8601DateFormatter` fails the whole parse on the wrong option rather than coping.
    private static func isoDate(_ iso: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: iso) { return date }
        return ISO8601DateFormatter().date(from: iso)
    }
}
