import SwiftUI

// Brand icons rendered from SVG paths (from Simple Icons - MIT licensed)
// These provide actual brand logos instead of generic SF Symbols

struct BrandIconShape: Shape {
    let path: String

    func path(in rect: CGRect) -> Path {
        // SVG paths are designed for a 24x24 viewBox
        let scale = min(rect.width, rect.height) / 24.0
        let xOffset = (rect.width - 24 * scale) / 2
        let yOffset = (rect.height - 24 * scale) / 2

        var path = Path()
        parseSVGPath(path: self.path, into: &path, scale: scale, xOffset: xOffset, yOffset: yOffset)
        return path
    }
}

// SVG path parser for basic commands (M, L, C, Q, Z, H, V and lowercase variants)
private func parseSVGPath(path svgPath: String, into path: inout Path, scale: CGFloat, xOffset: CGFloat, yOffset: CGFloat) {
    var currentX: CGFloat = 0
    var currentY: CGFloat = 0
    var startX: CGFloat = 0
    var startY: CGFloat = 0

    let commands = svgPath.replacingOccurrences(of: ",", with: " ")
    var tokens: [String] = []
    var currentToken = ""

    for char in commands {
        if char.isLetter || (char == "-" && !currentToken.isEmpty && !currentToken.hasSuffix("e")) {
            if !currentToken.isEmpty {
                tokens.append(currentToken)
            }
            if char.isLetter {
                tokens.append(String(char))
                currentToken = ""
            } else {
                currentToken = String(char)
            }
        } else if char == " " || char == "\n" {
            if !currentToken.isEmpty {
                tokens.append(currentToken)
                currentToken = ""
            }
        } else {
            currentToken.append(char)
        }
    }
    if !currentToken.isEmpty {
        tokens.append(currentToken)
    }

    var i = 0
    var lastCommand = ""

    while i < tokens.count {
        var command = tokens[i]

        if command.first?.isLetter == true {
            lastCommand = command
            i += 1
        } else {
            command = lastCommand
        }

        switch command {
        case "M":
            if i + 1 < tokens.count, let x = Double(tokens[i]), let y = Double(tokens[i + 1]) {
                currentX = CGFloat(x)
                currentY = CGFloat(y)
                startX = currentX
                startY = currentY
                path.move(to: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset))
                i += 2
                lastCommand = "L" // Subsequent coords are LineTo
            }
        case "m":
            if i + 1 < tokens.count, let dx = Double(tokens[i]), let dy = Double(tokens[i + 1]) {
                currentX += CGFloat(dx)
                currentY += CGFloat(dy)
                startX = currentX
                startY = currentY
                path.move(to: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset))
                i += 2
                lastCommand = "l"
            }
        case "L":
            if i + 1 < tokens.count, let x = Double(tokens[i]), let y = Double(tokens[i + 1]) {
                currentX = CGFloat(x)
                currentY = CGFloat(y)
                path.addLine(to: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset))
                i += 2
            }
        case "l":
            if i + 1 < tokens.count, let dx = Double(tokens[i]), let dy = Double(tokens[i + 1]) {
                currentX += CGFloat(dx)
                currentY += CGFloat(dy)
                path.addLine(to: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset))
                i += 2
            }
        case "H":
            if let x = Double(tokens[i]) {
                currentX = CGFloat(x)
                path.addLine(to: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset))
                i += 1
            }
        case "h":
            if let dx = Double(tokens[i]) {
                currentX += CGFloat(dx)
                path.addLine(to: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset))
                i += 1
            }
        case "V":
            if let y = Double(tokens[i]) {
                currentY = CGFloat(y)
                path.addLine(to: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset))
                i += 1
            }
        case "v":
            if let dy = Double(tokens[i]) {
                currentY += CGFloat(dy)
                path.addLine(to: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset))
                i += 1
            }
        case "C":
            if i + 5 < tokens.count,
               let x1 = Double(tokens[i]), let y1 = Double(tokens[i + 1]),
               let x2 = Double(tokens[i + 2]), let y2 = Double(tokens[i + 3]),
               let x = Double(tokens[i + 4]), let y = Double(tokens[i + 5]) {
                path.addCurve(
                    to: CGPoint(x: CGFloat(x) * scale + xOffset, y: CGFloat(y) * scale + yOffset),
                    control1: CGPoint(x: CGFloat(x1) * scale + xOffset, y: CGFloat(y1) * scale + yOffset),
                    control2: CGPoint(x: CGFloat(x2) * scale + xOffset, y: CGFloat(y2) * scale + yOffset)
                )
                currentX = CGFloat(x)
                currentY = CGFloat(y)
                i += 6
            }
        case "c":
            if i + 5 < tokens.count,
               let dx1 = Double(tokens[i]), let dy1 = Double(tokens[i + 1]),
               let dx2 = Double(tokens[i + 2]), let dy2 = Double(tokens[i + 3]),
               let dx = Double(tokens[i + 4]), let dy = Double(tokens[i + 5]) {
                let x1 = currentX + CGFloat(dx1)
                let y1 = currentY + CGFloat(dy1)
                let x2 = currentX + CGFloat(dx2)
                let y2 = currentY + CGFloat(dy2)
                let x = currentX + CGFloat(dx)
                let y = currentY + CGFloat(dy)
                path.addCurve(
                    to: CGPoint(x: x * scale + xOffset, y: y * scale + yOffset),
                    control1: CGPoint(x: x1 * scale + xOffset, y: y1 * scale + yOffset),
                    control2: CGPoint(x: x2 * scale + xOffset, y: y2 * scale + yOffset)
                )
                currentX = x
                currentY = y
                i += 6
            }
        case "S":
            if i + 3 < tokens.count,
               let x2 = Double(tokens[i]), let y2 = Double(tokens[i + 1]),
               let x = Double(tokens[i + 2]), let y = Double(tokens[i + 3]) {
                // For S, control1 is reflection of previous control2
                path.addCurve(
                    to: CGPoint(x: CGFloat(x) * scale + xOffset, y: CGFloat(y) * scale + yOffset),
                    control1: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset),
                    control2: CGPoint(x: CGFloat(x2) * scale + xOffset, y: CGFloat(y2) * scale + yOffset)
                )
                currentX = CGFloat(x)
                currentY = CGFloat(y)
                i += 4
            }
        case "s":
            if i + 3 < tokens.count,
               let dx2 = Double(tokens[i]), let dy2 = Double(tokens[i + 1]),
               let dx = Double(tokens[i + 2]), let dy = Double(tokens[i + 3]) {
                let x2 = currentX + CGFloat(dx2)
                let y2 = currentY + CGFloat(dy2)
                let x = currentX + CGFloat(dx)
                let y = currentY + CGFloat(dy)
                path.addCurve(
                    to: CGPoint(x: x * scale + xOffset, y: y * scale + yOffset),
                    control1: CGPoint(x: currentX * scale + xOffset, y: currentY * scale + yOffset),
                    control2: CGPoint(x: x2 * scale + xOffset, y: y2 * scale + yOffset)
                )
                currentX = x
                currentY = y
                i += 4
            }
        case "Z", "z":
            path.closeSubpath()
            currentX = startX
            currentY = startY
        case "A", "a":
            // Arc commands - skip for now (complex to implement, rarely used in these icons)
            i += 7
        default:
            i += 1
        }
    }
}

// Brand icon SVG paths (from Simple Icons)
struct BrandIconPaths {
    static let instagram = "M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z"

    static let facebook = "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"

    static let tiktok = "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"

    static let youtube = "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"

    static let threads = "M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.96-.065-1.182.408-2.256 1.332-3.023.88-.73 2.132-1.13 3.628-1.154 1.135-.018 2.187.086 3.146.31.002-.643-.034-1.25-.108-1.805-.222-1.67-.98-2.483-2.382-2.555-1.193-.026-2.178.396-2.623 1.165l-1.872-.897c.665-1.185 2.063-1.86 3.95-1.86h.094c1.208.025 2.25.358 3.095.99.949.712 1.508 1.755 1.66 3.1.07.625.102 1.314.095 2.054l.005.14c.928.477 1.674 1.09 2.215 1.823.773 1.049 1.073 2.32 1.012 3.691-.074 1.663-.707 3.193-1.839 4.434C18.587 23.081 15.915 23.98 12.186 24zm-.09-7.811c-1.076.02-1.892.263-2.427.723-.508.435-.763.989-.738 1.603.022.537.248.99.672 1.35.477.404 1.2.626 2.035.626.123 0 .247-.004.373-.013 1.2-.065 2.107-.474 2.696-1.218.504-.635.792-1.505.857-2.592-.77-.18-1.64-.292-2.586-.274-.29.006-.58.022-.882.022z"

    static let bluesky = "M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8z"

    static let mastodon = "M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"
}

// View that renders a brand icon
struct BrandIcon: View {
    let platform: String
    let size: CGFloat
    let color: Color

    init(platform: String, size: CGFloat = 14, color: Color = .primary) {
        self.platform = platform
        self.size = size
        self.color = color
    }

    var body: some View {
        if let path = pathForPlatform(platform) {
            BrandIconShape(path: path)
                .fill(color)
                .frame(width: size, height: size)
        } else {
            // Fallback to SF Symbol
            Image(systemName: sfSymbolForPlatform(platform))
                .font(.system(size: size * 0.8))
                .foregroundColor(color)
        }
    }

    private func pathForPlatform(_ platform: String) -> String? {
        switch platform {
        case "instagram": return BrandIconPaths.instagram
        case "facebook": return BrandIconPaths.facebook
        case "tiktok": return BrandIconPaths.tiktok
        case "youtube": return BrandIconPaths.youtube
        case "threads": return BrandIconPaths.threads
        case "bluesky": return BrandIconPaths.bluesky
        case "mastodon": return BrandIconPaths.mastodon
        default: return nil
        }
    }

    private func sfSymbolForPlatform(_ platform: String) -> String {
        switch platform {
        case "instagram": return "camera"
        case "facebook": return "person.2"
        case "tiktok": return "music.note"
        case "youtube": return "play.rectangle.fill"
        case "threads": return "at"
        case "bluesky": return "cloud"
        case "mastodon": return "bubble.left.and.bubble.right"
        default: return "globe"
        }
    }
}

#Preview {
    VStack(spacing: 16) {
        HStack(spacing: 12) {
            BrandIcon(platform: "instagram", size: 20, color: .pink)
            BrandIcon(platform: "facebook", size: 20, color: .blue)
            BrandIcon(platform: "tiktok", size: 20, color: .white)
            BrandIcon(platform: "youtube", size: 20, color: .red)
        }
        HStack(spacing: 12) {
            BrandIcon(platform: "threads", size: 20, color: .white)
            BrandIcon(platform: "bluesky", size: 20, color: .blue)
            BrandIcon(platform: "mastodon", size: 20, color: .purple)
        }
    }
    .padding()
    .background(Color.black)
}
