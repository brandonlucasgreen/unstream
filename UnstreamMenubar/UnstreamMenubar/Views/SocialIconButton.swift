import SwiftUI

struct SocialIconButton: View {
    let result: PlatformResult

    // Social platforms that have brand icons
    private let brandIconPlatforms: Set<String> = ["instagram", "facebook", "tiktok", "youtube", "threads", "bluesky", "mastodon"]

    var body: some View {
        Button(action: openPlatform) {
            Group {
                if brandIconPlatforms.contains(result.sourceId) {
                    BrandIcon(platform: result.sourceId, size: 14, color: iconColor)
                } else {
                    Image(systemName: result.icon)
                        .font(.system(size: 14))
                        .foregroundColor(iconColor)
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
