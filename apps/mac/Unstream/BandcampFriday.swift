import Foundation

// UPDATE ANNUALLY: Bandcamp Friday dates from https://daily.bandcamp.com/features/bandcamp-fridays
// Dates run midnight-to-midnight Pacific time
private let bandcampFridayDates: Set<String> = [
    // 2026 — first Fridays of each month
    "2026-01-02", "2026-02-06", "2026-03-06", "2026-04-03",
    "2026-05-01", "2026-06-05", "2026-07-03", "2026-08-07",
    "2026-09-04", "2026-10-02", "2026-11-06", "2026-12-04",
]

func isBandcampFriday(now: Date = Date()) -> Bool {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.timeZone = TimeZone(identifier: "America/Los_Angeles")
    let pacificDate = formatter.string(from: now)
    return bandcampFridayDates.contains(pacificDate)
}
