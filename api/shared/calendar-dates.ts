// Calendar dates as YYYY-MM-DD strings, counted in whole UTC days. The release autopost planner
// (api/functions/autopost-plan.ts) and the Promote page's editors both reason in these, and they
// have to agree: the server plans the days the browser draws. One copy, imported by both.

/** Midnight UTC of a YYYY-MM-DD date, in milliseconds. */
export function dateToUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, days: number): string {
  return new Date(dateToUtcMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateToUtcMs(b) - dateToUtcMs(a)) / 86_400_000);
}
