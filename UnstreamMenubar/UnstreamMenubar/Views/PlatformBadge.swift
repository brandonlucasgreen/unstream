import SwiftUI

struct PlatformBadge: View {
    let result: PlatformResult
    var isSubtle: Bool = false

    var body: some View {
        Button(action: openPlatform) {
            HStack(spacing: 4) {
                Image(systemName: result.icon)
                    .font(.system(size: 10))
                Text(isSubtle ? "Search \(result.displayName)" : result.displayName)
                    .font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(badgeColor.opacity(isSubtle ? 0.08 : 0.15))
            .foregroundColor(isSubtle ? badgeColor.opacity(0.7) : badgeColor)
            .cornerRadius(6)
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(isSubtle ? badgeColor.opacity(0.2) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .help(isSubtle ? "Search for artist on \(result.displayName)" : "Open on \(result.displayName)")
    }

    private var badgeColor: Color {
        Color(hex: result.color) ?? .blue
    }

    private func openPlatform() {
        if let urlString = result.url, let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }
}

// Color extension to parse hex strings
extension Color {
    init?(hex: String) {
        var hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        hexSanitized = hexSanitized.replacingOccurrences(of: "#", with: "")

        guard hexSanitized.count == 6,
              let hexNumber = UInt64(hexSanitized, radix: 16) else {
            return nil
        }

        let r = Double((hexNumber & 0xFF0000) >> 16) / 255.0
        let g = Double((hexNumber & 0x00FF00) >> 8) / 255.0
        let b = Double(hexNumber & 0x0000FF) / 255.0

        self.init(red: r, green: g, blue: b)
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
                sourceId: "kofi",
                url: nil,
                latestRelease: nil
            ), isSubtle: true)
        }
    }
    .padding()
}
