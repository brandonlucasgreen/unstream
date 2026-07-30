import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Copies a URL to the clipboard.
///
/// On macOS we write the `NSURL` itself rather than its string: NSURL declares both
/// `public.url` and plain-text representations, so pasting into a browser's address bar
/// and into a text editor each get something useful. Writing only a string would lose
/// the URL type.
func copyToClipboard(url: URL) {
    #if os(macOS)
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.writeObjects([url as NSURL])
    #else
    UIPasteboard.general.url = url
    #endif
}

func copyToClipboard(text: String) {
    #if os(macOS)
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}
