import SwiftUI
import AppKit

struct SocialIconButton: View {
    let result: PlatformResult
    @Environment(\.colorScheme) var colorScheme

    // Platforms that have brand SVG icons
    private let brandIconPlatforms: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "mastodon", "bandcamp"]

    var body: some View {
        Button(action: openPlatform) {
            Group {
                if brandIconPlatforms.contains(result.sourceId),
                   let url = Bundle.main.url(forResource: result.sourceId, withExtension: "svg"),
                   let nsImage = NSImage(contentsOf: url) {
                    Image(nsImage: nsImage)
                        .renderingMode(.template)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 14, height: 14)
                        .foregroundColor(colorScheme == .dark ? .white : iconColor)
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
        .help("Open \(result.displayName)")
    }

    private var iconColor: Color {
        // Use light gray for black/dark icons (better visibility on dark backgrounds)
        let hex = result.color
        if hex == "#000000" || hex == "#E0E0E0" {
            return Color(white: 0.7)
        }
        return Color(hex: hex) ?? .blue
    }

    private func openPlatform() {
        if let urlString = result.url, let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }
}

#Preview {
    HStack(spacing: 8) {
        SocialIconButton(result: PlatformResult(
            sourceId: "instagram",
            url: "https://instagram.com/test",
            latestRelease: nil
        ))
        SocialIconButton(result: PlatformResult(
            sourceId: "youtube",
            url: "https://youtube.com/test",
            latestRelease: nil
        ))
        SocialIconButton(result: PlatformResult(
            sourceId: "tiktok",
            url: "https://tiktok.com/@test",
            latestRelease: nil
        ))
    }
    .padding()
}
