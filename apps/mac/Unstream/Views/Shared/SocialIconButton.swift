import SwiftUI

#if os(macOS)
import AppKit
#endif

struct SocialIconButton: View {
    let result: PlatformResult
    var onOpen: (() -> Void)? = nil
    @Environment(\.colorScheme) var colorScheme

    #if os(iOS)
    @Environment(\.openURL) private var openURL
    #endif

    // Platforms that have brand SVG icons
    private let brandIconPlatforms: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "mastodon", "peertube", "bandcamp"]

    var body: some View {
        Button(action: openPlatform) {
            Group {
                if brandIconPlatforms.contains(result.sourceId) {
                    BrandIcon(
                        platform: result.sourceId,
                        size: 14,
                        color: colorScheme == .dark ? .white : iconColor
                    )
                } else {
                    Image(systemName: result.icon)
                        .font(.system(size: 14))
                        .foregroundColor(colorScheme == .dark ? .white : iconColor)
                }
            }
            .frame(width: 28, height: 28)
            .background(iconColor.opacity(0.15))
            .cornerRadius(14)
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .help("Open \(result.displayName)")
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
            openURL(url)
            #endif
            onOpen?()
        }
    }
}
