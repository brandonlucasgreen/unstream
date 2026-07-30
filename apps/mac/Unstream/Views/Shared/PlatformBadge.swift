import SwiftUI

#if os(macOS)
import AppKit
#endif

struct PlatformBadge: View {
    let result: PlatformResult
    var isSubtle: Bool = false
    var onOpen: (() -> Void)? = nil

    #if os(iOS)
    @State private var safariItem: SafariURL?
    #endif

    private var isBCFriday: Bool {
        result.sourceId == "bandcamp" && isBandcampFriday()
    }

    #if os(iOS)
    private let iconSize: CGFloat = 14
    private let paddingH: CGFloat = 12
    private let paddingV: CGFloat = 10
    private let spacing: CGFloat = 6
    private let labelFont: Font = .system(size: 14, weight: .medium)
    private let payoutFont: Font = .system(size: 12, weight: .semibold)
    private let fridayFont: Font = .system(size: 12, weight: .bold)
    #else
    private let iconSize: CGFloat = 10
    private let paddingH: CGFloat = 8
    private let paddingV: CGFloat = 4
    private let spacing: CGFloat = 4
    private let labelFont: Font = .caption.weight(.medium)
    private let payoutFont: Font = .caption2.weight(.semibold)
    private let fridayFont: Font = .caption2.weight(.bold)
    #endif

    var body: some View {
        Button(action: openPlatform) {
            HStack(spacing: spacing) {
                Image(systemName: result.icon)
                    .font(.system(size: iconSize))
                Text(isSubtle ? "Search \(result.displayName)" : result.displayName)
                    .font(labelFont)

                // Payout percentage badge
                if !isSubtle, let payout = displayPayout {
                    Text(payout)
                        .font(payoutFont)
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(isBCFriday ? Color(hex: "#1DA0C3")!.opacity(0.2) : badgeColor.opacity(0.2))
                        .cornerRadius(3)
                }

                // BC Friday label
                if !isSubtle && isBCFriday {
                    Text("BC Friday!")
                        .font(fridayFont)
                        .foregroundColor(Color(hex: "#1DA0C3") ?? .blue)
                }
            }
            .padding(.horizontal, paddingH)
            .padding(.vertical, paddingV)
            .background(badgeColor.opacity(isSubtle ? 0.08 : 0.15))
            .foregroundColor(isSubtle ? badgeColor.opacity(0.7) : badgeColor)
            .cornerRadius(6)
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(isSubtle ? badgeColor.opacity(0.2) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityText)
        #if os(macOS)
        .help(helpText)
        #endif
        // A badge is fundamentally a link, so it should behave like one: draggable to
        // Safari/Notes/Finder, and right-clickable for copy/open.
        .linkActions(
            url: platformURL,
            openTitle: isSubtle ? "Search \(result.displayName)" : "Open on \(result.displayName)",
            onOpen: openPlatform
        )
        #if os(iOS)
        .safariSheet(safariItem: $safariItem)
        #endif
    }

    private var platformURL: URL? {
        guard let urlString = result.url else { return nil }
        return URL(string: urlString)
    }

    private var accessibilityText: String {
        if isSubtle { return "Search for artist on \(result.displayName)" }
        if let payout = result.artistPayoutPercent {
            return "Open on \(result.displayName), \(payout) to artist"
        }
        return "Open on \(result.displayName)"
    }

    private var displayPayout: String? {
        if isBCFriday { return "~97%" }
        return result.artistPayoutPercent
    }

    private var helpText: String {
        if isSubtle {
            return "Search for artist on \(result.displayName)"
        }
        if isBCFriday {
            return "It's Bandcamp Friday! Artists get ~97% of every sale."
        }
        if let payout = result.artistPayoutPercent {
            return "Open on \(result.displayName) (\(payout) to artist)"
        }
        return "Open on \(result.displayName)"
    }

    private var badgeColor: Color {
        Color(hex: result.color) ?? .blue
    }

    private func openPlatform() {
        if let urlString = result.url, let url = URL(string: urlString) {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #else
            safariItem = SafariURL(url: url)
            #endif
            onOpen?()
        }
    }
}

#Preview {
    VStack(spacing: 10) {
        HStack {
            PlatformBadge(result: PlatformResult(
                sourceId: "bandcamp",
                url: "https://radiohead.bandcamp.com",
                latestRelease: nil
            ))
            PlatformBadge(result: PlatformResult(
                sourceId: "qobuz",
                url: nil,
                latestRelease: nil
            ))
        }
        HStack {
            PlatformBadge(result: PlatformResult(
                sourceId: "ampwall",
                url: nil,
                latestRelease: nil
            ), isSubtle: true)
            PlatformBadge(result: PlatformResult(
                sourceId: "subvert",
                url: nil,
                latestRelease: nil
            ), isSubtle: true)
            PlatformBadge(result: PlatformResult(
                sourceId: "kofi",
                url: nil,
                latestRelease: nil
            ), isSubtle: true)
        }
    }
    .padding()
}
