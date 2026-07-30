import AppKit
import SwiftUI

/// Provides "Find on Unstream" in the system Services menu, so selecting an artist
/// name anywhere on the Mac — a browser, Notes, Mail, a text editor — can look up
/// where that artist sells directly.
///
/// Registration has two halves that must agree: the `NSServices` entry in
/// Info-macOS.plist declares `NSMessage` = `findOnUnstream`, and AppKit looks for a
/// selector of the form `findOnUnstream:userData:error:` on `NSApp.servicesProvider`.
/// Rename one without the other and the menu item silently does nothing.
@MainActor
final class ServicesProvider: NSObject {
    static let shared = ServicesProvider()

    /// Longest selection we'll accept. Services hand us whatever the user had
    /// highlighted, which could be an entire document; an artist name is short, and
    /// a huge string would just produce a garbage query.
    private static let maxQueryLength = 100

    /// Fails the Debug build if the plist's `NSMessage` and our selector drift apart.
    /// This mismatch has no runtime symptom — the menu item just silently does
    /// nothing — so it needs to be caught at launch rather than in the wild.
    static func assertSelectorMatchesInfoPlist() {
        guard let services = Bundle.main.infoDictionary?["NSServices"] as? [[String: Any]],
              let message = services.first?["NSMessage"] as? String else {
            assertionFailure("No NSServices/NSMessage in Info.plist — 'Find on Unstream' will not appear.")
            return
        }
        let selector = Selector("\(message):userData:error:")
        assert(
            shared.responds(to: selector),
            "NSServices NSMessage '\(message)' has no matching \(message):userData:error: on ServicesProvider."
        )
    }

    @objc func findOnUnstream(
        _ pasteboard: NSPasteboard,
        userData: String?,
        error: AutoreleasingUnsafeMutablePointer<NSString>?
    ) {
        guard let raw = pasteboard.string(forType: .string) else {
            error?.pointee = "Unstream couldn't read the selected text." as NSString
            return
        }

        // Selections routinely carry newlines and padding; collapse to one line.
        let query = raw
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !query.isEmpty else {
            error?.pointee = "Select an artist name first." as NSString
            return
        }

        guard query.count <= Self.maxQueryLength else {
            error?.pointee = "That selection is too long to search — select just the artist name." as NSString
            return
        }

        AppDelegate.shared?.searchFromExternalRequest(query)
    }
}
