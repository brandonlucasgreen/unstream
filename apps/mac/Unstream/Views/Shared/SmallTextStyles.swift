import SwiftUI

/// Small-text styles that come out the same size on both platforms.
///
/// `.caption` and `.caption2` are 12pt and 11pt on iOS, but on the Mac both are 10pt — the
/// smallest text size macOS has. Views shared between the two were written against the iOS
/// sizes, which is most of why the menu-bar popover read as cramped: nearly every label in it
/// was 10pt. These keep the iOS styles on iOS and use the Mac styles with the same point sizes
/// on the Mac.
///
/// Mac-only views use `.callout` and `.subheadline` directly; these are for shared views.
extension Font {
    #if os(macOS)
    /// 12pt: secondary labels, section labels, small buttons.
    static let smallText: Font = .callout
    /// 11pt: dates, footnotes, fine print.
    static let smallerText: Font = .subheadline
    #else
    static let smallText: Font = .caption
    static let smallerText: Font = .caption2
    #endif
}
