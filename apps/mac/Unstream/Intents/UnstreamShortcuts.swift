import AppIntents

#if os(macOS)
import AppKit

/// The companion to `FindArtistIntent`: instead of returning text, this opens the
/// popover with the search already run — the same entry point the Services menu uses.
/// Useful bound to a keyboard shortcut or spoken when you want to browse results and
/// click through to a platform, rather than get an answer back into a Shortcut.
struct SearchInUnstreamIntent: AppIntent {
    static var title: LocalizedStringResource = "Search Unstream"

    static var description = IntentDescription(
        "Opens Unstream and searches for an artist.",
        categoryName: "Search"
    )

    static var openAppWhenRun = true

    @Parameter(title: "Artist", requestValueDialog: "Which artist?")
    var artist: String

    static var parameterSummary: some ParameterSummary {
        Summary("Search Unstream for \(\.$artist)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let name = artist.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            throw $artist.needsValueError("Which artist would you like to search for?")
        }
        AppDelegate.shared?.searchFromExternalRequest(name)
        return .result()
    }
}
#endif

/// Makes the intents discoverable in the Shortcuts app and Spotlight without the user
/// building a shortcut first. `${applicationName}` is required in at least one phrase
/// per shortcut, which is why every phrase names the app.
struct UnstreamShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: FindArtistIntent(),
            phrases: [
                "Find where an artist sells directly with \(.applicationName)",
                "Ask \(.applicationName) where an artist sells directly",
                "Look up an artist in \(.applicationName)"
            ],
            shortTitle: "Find Artist",
            systemImageName: "magnifyingglass.circle"
        )

        #if os(macOS)
        AppShortcut(
            intent: SearchInUnstreamIntent(),
            phrases: [
                "Search \(.applicationName)",
                "Search for an artist in \(.applicationName)"
            ],
            shortTitle: "Search",
            systemImageName: "magnifyingglass"
        )
        #endif
    }
}
