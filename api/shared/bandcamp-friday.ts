// Bandcamp Friday dates — shared between the edge function and API endpoints.
// UPDATE ANNUALLY: Bandcamp Friday dates from https://daily.bandcamp.com/features/bandcamp-fridays

export const BANDCAMP_FRIDAY_DATES: string[] = [
  '2026-03-06', '2026-05-02', '2026-08-07',
  '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04',
];

export function isBandcampFriday(): boolean {
  const pacificDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return BANDCAMP_FRIDAY_DATES.includes(pacificDate);
}