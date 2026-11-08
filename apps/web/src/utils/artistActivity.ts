import { formatUsd } from '../../../../api/shared/tips';

// The sentences on an artist's Analytics page, one per activity item. The server sends counts and
// kinds (api/functions/artist-activity.ts); the words live here, next to the page that shows them.
//
// Written to be true at the sizes artists actually see — a single save, two clicks — so every
// line has a one form and a many form, and none of them names or locates a fan.

export type ActivityKind =
  | 'tip'
  | 'saved'
  | 'supported'
  | 'collected'
  | 'release_alert'
  | 'streaming'
  | 'click'
  | 'release_view'
  | 'view'
  | 'search';

export interface ActivityItem {
  day: string;
  kind: ActivityKind;
  count: number;
  release?: string;
  platforms?: string[];
  amountCents?: number;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "Bandcamp", "Bandcamp and Mirlo", "Bandcamp, Mirlo and Ampwall". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function describeActivity(item: ActivityItem, platformName: (id: string) => string): string {
  const n = item.count;
  switch (item.kind) {
    case 'tip':
      return n === 1
        ? `You got a ${formatUsd(item.amountCents ?? 0)} tip`
        : `You got ${n} tips, ${formatUsd(item.amountCents ?? 0)} in all`;
    case 'saved':
      return n === 1 ? 'A fan saved you' : `${n} fans saved you`;
    case 'supported':
      return n === 1 ? 'A fan marked you as supported' : `${n} fans marked you as supported`;
    case 'collected':
      return n === 1
        ? `${item.release} showed up in a fan's collection`
        : `${item.release} showed up in ${n} fans' collections`;
    case 'release_alert':
      return `Your release alert for ${item.release} went to ${n} ${plural(n, 'fan', 'fans')}`;
    case 'streaming':
      return n === 1
        ? 'A fan listening to you on a streaming service was shown where to support you'
        : `${n} times, fans listening to you on a streaming service were shown where to support you`;
    case 'click':
      return `${n} ${plural(n, 'click', 'clicks')} through to your ${joinNames((item.platforms ?? []).map(platformName))}`;
    case 'release_view':
      return `${n} ${plural(n, 'view', 'views')} of ${item.release}`;
    case 'view':
      return `${n} ${plural(n, 'view', 'views')} of your Unstream page`;
    case 'search':
      return `You came up in ${n} ${plural(n, 'search', 'searches')}`;
  }
}

/** "Today", "Yesterday", or a short date — the day an item happened, in UTC like the counts. */
export function describeDay(day: string, today: Date = new Date()): string {
  const todayIso = today.toISOString().slice(0, 10);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (day === todayIso) return 'Today';
  if (day === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
  const date = new Date(`${day}T00:00:00Z`);
  const sameYear = date.getUTCFullYear() === today.getUTCFullYear();
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(date);
}
