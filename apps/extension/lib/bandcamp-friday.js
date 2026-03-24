// UPDATE ANNUALLY: Bandcamp Friday dates from https://daily.bandcamp.com/features/bandcamp-fridays
// Dates run midnight-to-midnight Pacific time
const BANDCAMP_FRIDAY_DATES = [
  // 2026
  '2026-03-06', '2026-05-02', '2026-08-07',
  '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04',
];

function isBandcampFriday(now) {
  const d = now || new Date();
  // en-CA locale gives YYYY-MM-DD format; timezone ensures Pacific time check
  const pacificDate = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return BANDCAMP_FRIDAY_DATES.includes(pacificDate);
}
