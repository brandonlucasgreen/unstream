import SwiftUI

// Color extension to parse hex strings
extension Color {
    init?(hex: String) {
        guard let rgb = Color.rgbComponents(hex: hex) else { return nil }
        self.init(red: rgb.r, green: rgb.g, blue: rgb.b)
    }

    fileprivate static func rgbComponents(hex: String) -> (r: Double, g: Double, b: Double)? {
        var hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        hexSanitized = hexSanitized.replacingOccurrences(of: "#", with: "")

        guard hexSanitized.count == 6,
              let hexNumber = UInt64(hexSanitized, radix: 16) else {
            return nil
        }

        return (
            r: Double((hexNumber & 0xFF0000) >> 16) / 255.0,
            g: Double((hexNumber & 0x00FF00) >> 8) / 255.0,
            b: Double(hexNumber & 0x0000FF) / 255.0
        )
    }
}

/// Platform brand colors come from each platform's own branding, which assumes a white
/// page. Several are unusable as foreground text in one appearance or the other:
/// Ampwall `#1E1E24` and Discogs `#333333` disappear in dark mode; Subvert `#D9DBDD`
/// and TikTok/Threads `#E0E0E0` disappear in light mode.
///
/// This clamps a brand color's luminance into a legible band for the current
/// appearance while keeping its hue, so badges stay recognizably on-brand. It replaces
/// scattered `hex == "#000000"` special cases, which only ever covered two values and
/// missed every platform above.
enum BrandColor {
    /// Luminance floor in dark mode and ceiling in light mode. Tuned so Ampwall and
    /// Discogs lift clear of a dark popover, and Subvert/TikTok drop clear of a light one.
    private static let darkModeMinLuminance = 0.55
    private static let lightModeMaxLuminance = 0.62

    static func legible(hex: String, isDark: Bool) -> Color {
        guard let rgb = Color.rgbComponents(hex: hex) else { return .accentColor }

        // Perceptual (Rec. 709) luminance — a flat RGB average would call yellow dark.
        let luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b

        if isDark, luminance < darkModeMinLuminance {
            return Color(
                red: lighten(rgb.r, toward: darkModeMinLuminance, from: luminance),
                green: lighten(rgb.g, toward: darkModeMinLuminance, from: luminance),
                blue: lighten(rgb.b, toward: darkModeMinLuminance, from: luminance)
            )
        }

        if !isDark, luminance > lightModeMaxLuminance {
            let scale = lightModeMaxLuminance / max(luminance, 0.001)
            return Color(red: rgb.r * scale, green: rgb.g * scale, blue: rgb.b * scale)
        }

        return Color(red: rgb.r, green: rgb.g, blue: rgb.b)
    }

    /// Blends toward white by however much the color is short of the target luminance.
    /// Scaling channels up (the mirror of the darken path) would clip and shift hue on
    /// near-black colors — Ampwall's `#1E1E24` would go pure blue.
    private static func lighten(_ channel: Double, toward target: Double, from luminance: Double) -> Double {
        let deficit = (target - luminance) / max(1 - luminance, 0.001)
        return channel + (1 - channel) * deficit
    }
}
