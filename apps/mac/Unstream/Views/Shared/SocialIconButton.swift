import SwiftUI

#if os(macOS)
import AppKit
#endif

struct SocialIconButton: View {
    let result: PlatformResult
    var onOpen: (() -> Void)? = nil
    @Environment(\.colorScheme) var colorScheme

    #if os(iOS)
    @State private var safariItem: SafariURL?
    #endif

    // Platforms that have brand SVG icons
    private let brandIconPlatforms: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "mastodon", "peertube", "bandcamp"]

    #if os(iOS)
    private let buttonSize: CGFloat = 44
    private let iconSize: CGFloat = 20
    #else
    private let buttonSize: CGFloat = 28
    private let iconSize: CGFloat = 14
    #endif

    var body: some View {
        Button(action: openPlatform) {
            Group {
                if brandIconPlatforms.contains(result.sourceId) {
                    BrandIcon(
                        platform: result.sourceId,
                        size: iconSize,
                        color: colorScheme == .dark ? .white : iconColor
                    )
                } else {
                    Image(systemName: result.icon)
                        .font(.system(size: iconSize))
                        .foregroundColor(colorScheme == .dark ? .white : iconColor)
                }
            }
            .frame(width: buttonSize, height: buttonSize)
            .background(iconColor.opacity(0.15))
            .cornerRadius(buttonSize / 2)
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .help("Open \(result.displayName)")
        #endif
        #if os(iOS)
        .safariSheet(safariItem: $safariItem)
        #endif
    }

    private var iconColor: Color {
        let hex = result.color
        if hex == "#000000" || hex == "#E0E0E0" {
            return Color(white: 0.7)
        }
        return Color(hex: hex) ?? .blue
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
