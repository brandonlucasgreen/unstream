import Foundation

/// Play counts: how many times each artist was played on this Mac, and how often their links were
/// opened, per calendar month. Kept in a file in the app's container and never sent anywhere. It
/// exists so a future year-end recap can say who someone actually listened to
/// (docs/specs/unwrapped-spec.md §4).
///
/// The browser extension keeps the same log in the same shape (`apps/extension/lib/listening-log.js`,
/// pinned by `apps/web/tests/unit/extension-listening-log.test.ts`); `ListeningLogTests` pins the
/// same cases here. Change the two together.
///
/// What's stored, and nothing more: per month, per artist, a display name, a play count and a
/// click count. No track titles, albums, timestamps or players.
struct ListeningLog: Codable, Equatable {
    struct ArtistCounts: Codable, Equatable {
        var name: String
        var plays: Int
        var clicks: Int
    }

    struct YearTotals: Equatable {
        var plays = 0
        var clicks = 0
        var artists = 0
    }

    enum Field {
        case plays
        case clicks
    }

    static let maxMonths = 24
    static let maxArtistsPerMonth = 2000

    var v = 1
    var months: [String: [String: ArtistCounts]] = [:]

    static func artistKey(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// "YYYY-MM" in the listener's own calendar, so December means their December.
    static func monthKey(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04ld-%02ld", parts.year ?? 0, parts.month ?? 0)
    }

    private static func monthIndex(_ key: String) -> Int? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        return parts[0] * 12 + (parts[1] - 1)
    }

    /// One more play or click for an artist, in the month `date` falls in.
    func adding(_ field: Field, for artistName: String, at date: Date, calendar: Calendar = .current) -> ListeningLog {
        let name = artistName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return self }

        let month = Self.monthKey(date, calendar: calendar)
        let key = Self.artistKey(name)
        var entries = months[month] ?? [:]
        var counts = entries[key] ?? ArtistCounts(name: name, plays: 0, clicks: 0)
        switch field {
        case .plays: counts.plays += 1
        case .clicks: counts.clicks += 1
        }
        entries[key] = counts

        var updated = self
        updated.months[month] = Self.capped(entries)
        return updated.pruned(now: date, calendar: calendar)
    }

    /// Keep the most-heard artists when a month grows past the cap.
    private static func capped(_ entries: [String: ArtistCounts]) -> [String: ArtistCounts] {
        guard entries.count > maxArtistsPerMonth else { return entries }
        let kept = entries
            .sorted { ($0.value.plays + $0.value.clicks) > ($1.value.plays + $1.value.clicks) }
            .prefix(maxArtistsPerMonth)
        return Dictionary(uniqueKeysWithValues: kept.map { ($0.key, $0.value) })
    }

    /// Drop months more than `maxMonths` before the month `now` falls in.
    func pruned(now: Date, calendar: Calendar = .current) -> ListeningLog {
        guard let newest = Self.monthIndex(Self.monthKey(now, calendar: calendar)) else { return self }
        var updated = self
        updated.months = months.filter { key, _ in
            guard let index = Self.monthIndex(key) else { return false }
            return newest - index < Self.maxMonths
        }
        return updated
    }

    /// Totals for one calendar year, for Settings.
    func totals(forYear year: Int) -> YearTotals {
        var totals = YearTotals()
        var artists = Set<String>()
        for (month, entries) in months where month.hasPrefix(String(format: "%04ld-", year)) {
            for (key, counts) in entries {
                totals.plays += counts.plays
                totals.clicks += counts.clicks
                artists.insert(key)
            }
        }
        totals.artists = artists.count
        return totals
    }
}

/// What counts as a play: a track that was playing for at least 30 seconds before the next track
/// started or playback stopped. `MediaObserver` publishes changes (a new track, or nothing playing),
/// so the time is measured at the next change rather than with a timer. A pause publishes nothing
/// playing, so paused time never counts. The extension applies the same rule.
struct PlayTrackState: Equatable {
    struct Current: Equatable {
        let key: String
        let artist: String
        let startedAt: Date
    }

    struct Counted: Equatable {
        let key: String
        let at: Date
    }

    var current: Current?
    var lastCounted: Counted?
}

enum PlayCounting {
    static let minPlaySeconds: TimeInterval = 30
    /// Pausing and resuming publishes the same track twice. A track counted in the last ten
    /// minutes isn't counted again, so a pause in the middle of a song is still one play.
    static let repeatGuardSeconds: TimeInterval = 10 * 60

    private static func trackKey(artist: String, title: String?) -> String {
        let normalizedTitle = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ListeningLog.artistKey(artist) + "\u{0}" + normalizedTitle
    }

    /// Close the track that was playing. Returns the artist to count a play for, if any.
    static func playbackStopped(_ state: PlayTrackState, now: Date) -> (state: PlayTrackState, countedArtist: String?) {
        guard let current = state.current else {
            return (PlayTrackState(current: nil, lastCounted: state.lastCounted), nil)
        }

        let playedLongEnough = now.timeIntervalSince(current.startedAt) >= minPlaySeconds
        var countedRecently = false
        if let last = state.lastCounted, last.key == current.key, now.timeIntervalSince(last.at) < repeatGuardSeconds {
            countedRecently = true
        }

        if playedLongEnough && !countedRecently {
            return (PlayTrackState(current: nil, lastCounted: .init(key: current.key, at: now)), current.artist)
        }
        return (PlayTrackState(current: nil, lastCounted: state.lastCounted), nil)
    }

    /// A track was published as playing. The same track again changes nothing; a different one
    /// closes the previous track (which may count a play) and starts timing this one.
    static func trackStarted(_ state: PlayTrackState, artist: String, title: String?, now: Date) -> (state: PlayTrackState, countedArtist: String?) {
        let key = trackKey(artist: artist, title: title)
        if state.current?.key == key { return (state, nil) }

        let closed = playbackStopped(state, now: now)
        let trimmedArtist = artist.trimmingCharacters(in: .whitespacesAndNewlines)
        return (
            PlayTrackState(current: .init(key: key, artist: trimmedArtist, startedAt: now), lastCounted: closed.state.lastCounted),
            closed.countedArtist
        )
    }
}
