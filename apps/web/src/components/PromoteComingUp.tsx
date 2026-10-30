import { useState } from 'react';
import { KIND_COPY } from './PromoteTemplatesEditor';
import { needsAttention, PromotePostStatus } from './PromotePostStatus';
import type { ScheduledPost } from '../services/promote';

// "Coming up" on the Promote page, a week at a time (Brandon, 2026-10-30): four week tabs from
// the artist's today, each with how many posts it holds, a strip of its seven days, and that
// week's posts underneath. The whole four weeks as one list was a lot to scroll through.

export type Posting = 'on' | 'off' | 'paused';

const WEEKS = 4;
const DAY_MS = 86_400_000;

/** Plain YYYY-MM-DD arithmetic, in UTC so no timezone moves a day. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function formatDate(date: string, options: Intl.DateTimeFormatOptions) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

/** One post: its picture, what it is, what it says, and where it stands. */
export function ScheduledPostItem({ post, imageFirstTicked, posting }: {
  post: ScheduledPost;
  imageFirstTicked: string[];
  posting: Posting;
}) {
  // Once it's in Buffer, which channels it went to is in its status instead.
  const skips = post.state.is !== 'in_buffer' && imageFirstTicked.length > 0 && !post.imageOnInstagram;
  return (
    <li className="flex gap-3">
      {post.imageUrl ? (
        <img src={post.imageUrl} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded object-cover bg-bg-secondary" />
      ) : (
        <div className="h-14 w-14 shrink-0 rounded bg-bg-secondary" aria-hidden="true" />
      )}
      <div className="min-w-0 space-y-1">
        <p className="text-xs text-text-muted">
          {formatDate(post.date, { weekday: 'short', day: 'numeric', month: 'short' })} · {KIND_COPY[post.kind].label}
          {post.release ? ` · ${post.release.title}` : ''}
          {skips ? ` · skips ${imageFirstTicked.join(' and ')}` : ''}
        </p>
        <p className="text-sm text-text-primary whitespace-pre-line break-words">{post.text ?? 'No template could be filled for this one, so it won’t post.'}</p>
        <PromotePostStatus state={post.state} posting={posting} />
      </div>
    </li>
  );
}

export function PromoteComingUp({ today, posts, imageFirstTicked, posting }: {
  today: string;
  posts: ScheduledPost[];
  imageFirstTicked: string[];
  posting: Posting;
}) {
  const [selected, setSelected] = useState(0);

  // Weeks run seven days from today. The plan reaches 28 days out, so its last day joins week four.
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ start: addDays(today, i * 7), posts: [] as ScheduledPost[] }));
  for (const post of posts) {
    const week = Math.min(WEEKS - 1, Math.max(0, Math.floor(daysBetween(today, post.date) / 7)));
    weeks[week].posts.push(post);
  }
  const week = weeks[selected];
  const days = Array.from({ length: 7 }, (_, i) => addDays(week.start, i));

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Weeks" className="grid grid-cols-4 gap-1.5">
        {weeks.map((w, i) => {
          const range = `${formatDate(w.start, { month: 'short', day: 'numeric' })} to ${formatDate(addDays(w.start, 6), { month: 'short', day: 'numeric' })}`;
          const attention = w.posts.some(p => needsAttention(p.state));
          return (
            <button
              key={w.start}
              type="button"
              role="tab"
              id={`promote-week-${i}`}
              aria-selected={i === selected}
              aria-controls="promote-week-panel"
              aria-label={`${i === 0 ? 'This week' : `Week of ${range}`}, ${w.posts.length} post${w.posts.length === 1 ? '' : 's'}${attention ? ', needs a look' : ''}`}
              onClick={() => setSelected(i)}
              className={`relative rounded-lg border px-2 py-1.5 text-left transition-colors ${
                i === selected ? 'border-accent-primary bg-bg-primary' : 'border-border hover:bg-bg-secondary'
              }`}
            >
              <span className="block text-xs text-text-muted">{i === 0 ? 'This week' : formatDate(w.start, { month: 'short', day: 'numeric' })}</span>
              <span className="block text-sm font-medium text-text-primary">
                {w.posts.length} post{w.posts.length === 1 ? '' : 's'}
              </span>
              {attention && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-error" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="promote-week-panel" aria-labelledby={`promote-week-${selected}`} className="space-y-3">
        {/* The week at a glance: which of its days post. */}
        <ol className="grid grid-cols-7 gap-1" aria-label="Days">
          {days.map(day => {
            const count = week.posts.filter(p => p.date === day).length;
            return (
              <li
                key={day}
                aria-label={`${formatDate(day, { weekday: 'long', month: 'short', day: 'numeric' })}: ${count ? `${count} post${count === 1 ? '' : 's'}` : 'nothing'}`}
                className={`rounded-md py-1 text-center ${count ? 'bg-accent-primary/15 text-text-primary' : 'text-text-muted'}`}
              >
                <span className="block text-[10px] uppercase tracking-wide" aria-hidden="true">{formatDate(day, { weekday: 'narrow' })}</span>
                <span className="block text-sm" aria-hidden="true">{formatDate(day, { day: 'numeric' })}</span>
              </li>
            );
          })}
        </ol>

        {week.posts.length === 0 ? (
          <p className="text-sm text-text-secondary">Nothing posts this week.</p>
        ) : (
          <ol className="space-y-3">
            {week.posts.map(post => <ScheduledPostItem key={post.at} post={post} imageFirstTicked={imageFirstTicked} posting={posting} />)}
          </ol>
        )}
      </div>
    </div>
  );
}
