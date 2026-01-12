import SwiftUI

struct SocialIconButton: View {
    let result: PlatformResult

    var body: some View {
        Button(action: openPlatform) {
            Image(systemName: result.icon)
                .font(.system(size: 14))
                .frame(width: 28, height: 28)
                .background(iconColor.opacity(0.15))
                .foregroundColor(iconColor)
                .cornerRadius(14)
        }
        .buttonStyle(.plain)
        .help("Open \(result.displayName)")
    }

    private var iconColor: Color {
        // Use light gray for black icons (better visibility on dark backgrounds)
        let hex = result.color
        if hex == "#000000" {
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
