import AppIntents
import Foundation

/// "Find where <artist> is available" — exposed to Shortcuts, Spotlight, and Siri.
///
/// Talks to `UnstreamAPI` directly rather than going through `AppState`, because an
/// intent can run when no popover has ever been shown and must not depend on view
/// state. It deliberately does *not* open the app: the point is to be usable inside
/// a larger Shortcut, so it returns a value instead of taking over the screen.
struct FindArtistIntent: AppIntent {
    static var title: LocalizedStringResource = "Find Where an Artist Sells Directly"

    static var description = IntentDescription(
        "Looks up an artist on Unstream and returns the platforms where they sell directly, with the share each one pays the artist.",
        categoryName: "Search"
    )

    static var openAppWhenRun = false

    @Parameter(title: "Artist", requestValueDialog: "Which artist?")
    var artist: String

    static var parameterSummary: some ParameterSummary {
        Summary("Find where \(\.$artist) sells directly")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let name = artist.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            throw $artist.needsValueError("Which artist would you like to look up?")
        }

        let api = UnstreamAPI()
        // .fuzzy matches the human-typed search field — someone dictating a name to
        // Siri is in the same position as someone typing it, not doing an exact
        // now-playing lookup.
        let (results, _) = try await api.searchArtist(name, mode: .fuzzy)

        guard let match = results.first else {
            let message = "No results for \(name) on Unstream."
            return .result(value: message, dialog: IntentDialog(stringLiteral: message))
        }

        let platforms = match.verifiedPlatforms
        guard !platforms.isEmpty else {
            let message = "\(match.name) is on Unstream, but no direct-sales platforms were found."
            return .result(value: message, dialog: IntentDialog(stringLiteral: message))
        }

        let lines = platforms.map { platform -> String in
            if let payout = platform.artistPayoutPercent {
                return "\(platform.displayName) (\(payout) to artist)"
            }
            return platform.displayName
        }

        let spoken = "\(match.name) sells directly on \(lines.prefix(3).joined(separator: ", "))."
        let value = """
        \(match.name)
        \(lines.map { "- \($0)" }.joined(separator: "\n"))
        """

        return .result(value: value, dialog: IntentDialog(stringLiteral: spoken))
    }
}
