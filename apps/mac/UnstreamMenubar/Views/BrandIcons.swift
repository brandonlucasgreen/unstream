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

// MARK: - SVG Path Tokenizer

/// Tokenizes an SVG path string into commands and numbers.
/// Handles adjacent decimals (e.g. "8.333.015" → "8.333", ".015"),
/// sign-separated numbers (e.g. "3-2" → "3", "-2"), and exponents.
private func tokenizeSVGPath(_ svgPath: String) -> [String] {
    var tokens: [String] = []
    var current = ""
    var hasDot = false

    func flush() {
        if !current.isEmpty {
            tokens.append(current)
            current = ""
            hasDot = false
        }
    }

    for char in svgPath {
        if char.isLetter && char != "e" && char != "E" {
            flush()
            tokens.append(String(char))
        } else if char == " " || char == "," || char == "\t" || char == "\n" || char == "\r" {
            flush()
        } else if char == "-" {
            // Minus starts a new number unless it's an exponent sign (e.g. "1e-3")
            if !current.isEmpty && !current.hasSuffix("e") && !current.hasSuffix("E") {
                flush()
            }
            current.append(char)
        } else if char == "." {
            // A second dot starts a new number (e.g. "8.333.015")
            if hasDot {
                flush()
            }
            current.append(char)
            hasDot = true
        } else {
            current.append(char)
        }
    }
    flush()
    return tokens
}

// MARK: - SVG Path Parser

private func parseSVGPath(path svgPath: String, into path: inout Path, scale: CGFloat, xOffset: CGFloat, yOffset: CGFloat) {
    var cx: CGFloat = 0
    var cy: CGFloat = 0
    var startX: CGFloat = 0
    var startY: CGFloat = 0
    var lastCx2: CGFloat = 0  // Last control point for S/s commands
    var lastCy2: CGFloat = 0
    var lastCmd = ""

    let tokens = tokenizeSVGPath(svgPath)

    func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: x * scale + xOffset, y: y * scale + yOffset)
    }

    func num(_ idx: Int) -> CGFloat? {
        guard idx < tokens.count else { return nil }
        return Double(tokens[idx]).map { CGFloat($0) }
    }

    var i = 0

    while i < tokens.count {
        var cmd = tokens[i]

        if cmd.first?.isLetter == true {
            lastCmd = cmd
            i += 1
        } else {
            cmd = lastCmd
        }

        switch cmd {
        case "M":
            guard let x = num(i), let y = num(i+1) else { i += 2; continue }
            cx = x; cy = y; startX = cx; startY = cy
            path.move(to: pt(cx, cy))
            lastCmd = "L"
            lastCx2 = cx; lastCy2 = cy
            i += 2

        case "m":
            guard let dx = num(i), let dy = num(i+1) else { i += 2; continue }
            cx += dx; cy += dy; startX = cx; startY = cy
            path.move(to: pt(cx, cy))
            lastCmd = "l"
            lastCx2 = cx; lastCy2 = cy
            i += 2

        case "L":
            guard let x = num(i), let y = num(i+1) else { i += 2; continue }
            cx = x; cy = y
            path.addLine(to: pt(cx, cy))
            lastCx2 = cx; lastCy2 = cy
            i += 2

        case "l":
            guard let dx = num(i), let dy = num(i+1) else { i += 2; continue }
            cx += dx; cy += dy
            path.addLine(to: pt(cx, cy))
            lastCx2 = cx; lastCy2 = cy
            i += 2

        case "H":
            guard let x = num(i) else { i += 1; continue }
            cx = x
            path.addLine(to: pt(cx, cy))
            lastCx2 = cx; lastCy2 = cy
            i += 1

        case "h":
            guard let dx = num(i) else { i += 1; continue }
            cx += dx
            path.addLine(to: pt(cx, cy))
            lastCx2 = cx; lastCy2 = cy
            i += 1

        case "V":
            guard let y = num(i) else { i += 1; continue }
            cy = y
            path.addLine(to: pt(cx, cy))
            lastCx2 = cx; lastCy2 = cy
            i += 1

        case "v":
            guard let dy = num(i) else { i += 1; continue }
            cy += dy
            path.addLine(to: pt(cx, cy))
            lastCx2 = cx; lastCy2 = cy
            i += 1

        case "C":
            guard let x1 = num(i), let y1 = num(i+1),
                  let x2 = num(i+2), let y2 = num(i+3),
                  let x = num(i+4), let y = num(i+5) else { i += 6; continue }
            path.addCurve(to: pt(x, y), control1: pt(x1, y1), control2: pt(x2, y2))
            lastCx2 = x2; lastCy2 = y2
            cx = x; cy = y
            i += 6

        case "c":
            guard let dx1 = num(i), let dy1 = num(i+1),
                  let dx2 = num(i+2), let dy2 = num(i+3),
                  let dx = num(i+4), let dy = num(i+5) else { i += 6; continue }
            let x1 = cx + dx1, y1 = cy + dy1
            let x2 = cx + dx2, y2 = cy + dy2
            let x = cx + dx, y = cy + dy
            path.addCurve(to: pt(x, y), control1: pt(x1, y1), control2: pt(x2, y2))
            lastCx2 = x2; lastCy2 = y2
            cx = x; cy = y
            i += 6

        case "S":
            guard let x2 = num(i), let y2 = num(i+1),
                  let x = num(i+2), let y = num(i+3) else { i += 4; continue }
            let x1 = 2 * cx - lastCx2
            let y1 = 2 * cy - lastCy2
            path.addCurve(to: pt(x, y), control1: pt(x1, y1), control2: pt(x2, y2))
            lastCx2 = x2; lastCy2 = y2
            cx = x; cy = y
            i += 4

        case "s":
            guard let dx2 = num(i), let dy2 = num(i+1),
                  let dx = num(i+2), let dy = num(i+3) else { i += 4; continue }
            let x1 = 2 * cx - lastCx2
            let y1 = 2 * cy - lastCy2
            let x2 = cx + dx2, y2 = cy + dy2
            let x = cx + dx, y = cy + dy
            path.addCurve(to: pt(x, y), control1: pt(x1, y1), control2: pt(x2, y2))
            lastCx2 = x2; lastCy2 = y2
            cx = x; cy = y
            i += 4

        case "Q":
            guard let x1 = num(i), let y1 = num(i+1),
                  let x = num(i+2), let y = num(i+3) else { i += 4; continue }
            path.addQuadCurve(to: pt(x, y), control: pt(x1, y1))
            lastCx2 = x1; lastCy2 = y1
            cx = x; cy = y
            i += 4

        case "q":
            guard let dx1 = num(i), let dy1 = num(i+1),
                  let dx = num(i+2), let dy = num(i+3) else { i += 4; continue }
            let x1 = cx + dx1, y1 = cy + dy1
            let x = cx + dx, y = cy + dy
            path.addQuadCurve(to: pt(x, y), control: pt(x1, y1))
            lastCx2 = x1; lastCy2 = y1
            cx = x; cy = y
            i += 4

        case "A", "a":
            guard let rx = num(i), let ry = num(i+1),
                  let rotation = num(i+2), let largeArc = num(i+3),
                  let sweep = num(i+4), let ex = num(i+5), let ey = num(i+6)
            else { i += 7; continue }

            let endX = cmd == "A" ? ex : cx + ex
            let endY = cmd == "A" ? ey : cy + ey

            addArcToBeziers(
                path: &path, scale: scale, xOffset: xOffset, yOffset: yOffset,
                cx: cx, cy: cy,
                rx: abs(rx), ry: abs(ry),
                rotation: rotation,
                largeArc: largeArc != 0,
                sweep: sweep != 0,
                endX: endX, endY: endY
            )

            cx = endX; cy = endY
            lastCx2 = cx; lastCy2 = cy
            i += 7

        case "Z", "z":
            path.closeSubpath()
            cx = startX; cy = startY
            lastCx2 = cx; lastCy2 = cy

        default:
            i += 1
        }
    }
}

// MARK: - SVG Arc to Bezier Conversion

/// Converts an SVG arc command to cubic bezier curves.
/// Based on the standard endpoint-to-center parameterization algorithm from the SVG spec.
private func addArcToBeziers(
    path: inout Path, scale: CGFloat, xOffset: CGFloat, yOffset: CGFloat,
    cx: CGFloat, cy: CGFloat,
    rx inputRx: CGFloat, ry inputRy: CGFloat,
    rotation: CGFloat,
    largeArc: Bool, sweep: Bool,
    endX: CGFloat, endY: CGFloat
) {
    // Degenerate cases
    if cx == endX && cy == endY { return }
    if inputRx == 0 || inputRy == 0 {
        path.addLine(to: CGPoint(x: endX * scale + xOffset, y: endY * scale + yOffset))
        return
    }

    let phi = rotation * .pi / 180
    let cosPhi = cos(phi)
    let sinPhi = sin(phi)

    // Step 1: Compute (x1', y1')
    let dx2 = (cx - endX) / 2
    let dy2 = (cy - endY) / 2
    let x1p = cosPhi * dx2 + sinPhi * dy2
    let y1p = -sinPhi * dx2 + cosPhi * dy2

    // Step 2: Compute (cx', cy')
    var rx = inputRx
    var ry = inputRy
    let x1p2 = x1p * x1p
    let y1p2 = y1p * y1p
    var rx2 = rx * rx
    var ry2 = ry * ry

    // Ensure radii are large enough
    let lambda = x1p2 / rx2 + y1p2 / ry2
    if lambda > 1 {
        let lambdaSqrt = sqrt(lambda)
        rx *= lambdaSqrt
        ry *= lambdaSqrt
        rx2 = rx * rx
        ry2 = ry * ry
    }

    let num = max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2)
    let den = rx2 * y1p2 + ry2 * x1p2
    var sq = den > 0 ? sqrt(num / den) : 0
    if largeArc == sweep { sq = -sq }

    let cxp = sq * rx * y1p / ry
    let cyp = -sq * ry * x1p / rx

    // Step 3: Compute (cx, cy) center
    let centerX = cosPhi * cxp - sinPhi * cyp + (cx + endX) / 2
    let centerY = sinPhi * cxp + cosPhi * cyp + (cy + endY) / 2

    // Step 4: Compute angles
    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
        let dot = ux * vx + uy * vy
        let len = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
        var a = len > 0 ? acos(max(-1, min(1, dot / len))) : 0
        if ux * vy - uy * vx < 0 { a = -a }
        return a
    }

    let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    var dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)

    if !sweep && dTheta > 0 { dTheta -= 2 * .pi }
    else if sweep && dTheta < 0 { dTheta += 2 * .pi }

    // Split into segments of at most π/2
    let segments = max(1, Int(ceil(abs(dTheta) / (.pi / 2))))
    let segAngle = dTheta / CGFloat(segments)

    for seg in 0..<segments {
        let t1 = theta1 + CGFloat(seg) * segAngle
        let t2 = t1 + segAngle

        // Bezier approximation of arc segment
        let alpha = sin(segAngle) * (sqrt(4 + 3 * pow(tan(segAngle / 2), 2)) - 1) / 3

        let cos1 = cos(t1), sin1 = sin(t1)
        let cos2 = cos(t2), sin2 = sin(t2)

        let ep1x = rx * cos1, ep1y = ry * sin1
        let ep2x = rx * cos2, ep2y = ry * sin2

        let cp1x = ep1x - alpha * rx * sin1
        let cp1y = ep1y + alpha * ry * cos1
        let cp2x = ep2x + alpha * rx * sin2
        let cp2y = ep2y - alpha * ry * cos2

        // Transform back
        func transform(_ px: CGFloat, _ py: CGFloat) -> CGPoint {
            let x = cosPhi * px - sinPhi * py + centerX
            let y = sinPhi * px + cosPhi * py + centerY
            return CGPoint(x: x * scale + xOffset, y: y * scale + yOffset)
        }

        let c1 = transform(cp1x, cp1y)
        let c2 = transform(cp2x, cp2y)
        let end = transform(ep2x, ep2y)

        path.addCurve(to: end, control1: c1, control2: c2)
    }
}

// MARK: - Brand Icon SVG Paths (from Simple Icons - https://simpleicons.org)

struct BrandIconPaths {
    static let instagram = "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077"

    static let facebook = "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"

    static let tiktok = "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"

    static let youtube = "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"

    static let threads = "M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z"

    static let bluesky = "M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026"

    static let bandcamp = "M0 18.75l7.437-13.5H24l-7.438 13.5H0z"

    static let mastodon = "M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"

    static let peertube = "M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-1.243 17.07V6.93L18.258 12l-7.5 5.07z"
}

// MARK: - Brand Icon View

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
        case "peertube": return BrandIconPaths.peertube
        case "bandcamp": return BrandIconPaths.bandcamp
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
        case "peertube": return "play.circle"
        case "bandcamp": return "music.note.house"
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
            BrandIcon(platform: "bandcamp", size: 20, color: .yellow)
        }
    }
    .padding()
    .background(Color.black)
}
