import type { ReactNode } from 'react';
import { networkName } from '../../../../api/shared/autopost-networks';
import type { PromoteChannelState, PromotePostState } from '../services/promote';

// Where one release autopost post stands, as a row of small chips under it in the Promote page's
// "Coming up" and "Recent": one per channel once it's in Buffer (scheduled, posted, failed,
// skipped), or one for the whole post before then. An icon and a word or two each, so the state
// reads at a glance (Brandon, 2026-10-30); why something failed or was skipped is the chip's
// tooltip. Built by api/functions/autopost-schedule-view.ts.

type Tone = 'muted' | 'neutral' | 'success' | 'warning' | 'error';

const TONES: Record<Tone, string> = {
  muted: 'border-border text-text-muted',
  neutral: 'border-border text-text-secondary',
  success: 'border-success/40 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  error: 'border-error/40 bg-error/10 text-error',
};

// Inline icons, as elsewhere on the site: 24×24 outlines drawn in currentColor.
const ICONS = {
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cross: <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  skip: <><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>,
  send: <path d="M4 12l16-8-6 16-2-6z" />,
  question: <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />,
} satisfies Record<string, ReactNode>;

interface ChipSpec {
  icon: keyof typeof ICONS;
  tone: Tone;
  label: string;
  /** Why, in full: the tooltip, and what a screen reader hears after the label. */
  detail?: string;
  href?: string;
}

function Chip({ icon, tone, label, detail, href }: ChipSpec) {
  const className = `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${TONES[tone]}`;
  const body = (
    <>
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[icon]}
      </svg>
      {label}
      {detail && <span className="sr-only">: {detail}</span>}
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" title={detail ?? 'View the post'} className={`${className} hover:underline`}>{body}</a>
  ) : (
    <span title={detail} className={className}>{body}</span>
  );
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function channelChip(c: PromoteChannelState): ChipSpec {
  const network = c.service ? networkName(c.service) : 'Buffer';
  switch (c.status) {
    case 'scheduled':
      return c.dueAt
        ? { icon: 'clock', tone: 'neutral', label: `${network} · ${formatTime(c.dueAt)}`, detail: `Scheduled in Buffer for ${formatDay(c.dueAt)}, ${formatTime(c.dueAt)}` }
        : { icon: 'clock', tone: 'neutral', label: `${network} · Scheduled` };
    case 'sending': return { icon: 'send', tone: 'neutral', label: `${network} · Publishing` };
    case 'sent': return { icon: 'check', tone: 'success', label: `${network} · Posted`, href: c.link ?? undefined };
    case 'error': return { icon: 'cross', tone: 'error', label: `${network} · Failed`, detail: c.error ?? 'Buffer couldn’t publish it' };
    case 'draft': return { icon: 'alert', tone: 'warning', label: `${network} · Draft`, detail: 'A draft in Buffer: it won’t post until it’s scheduled there' };
    case 'needs_approval': return { icon: 'alert', tone: 'warning', label: `${network} · Needs approval`, detail: 'Waiting for approval in Buffer' };
    case 'missing': return { icon: 'skip', tone: 'muted', label: `${network} · Removed`, detail: 'No longer in Buffer' };
    case 'unknown': return { icon: 'question', tone: 'muted', label: `${network} · In Buffer`, detail: 'Couldn’t check its status in Buffer just now' };
    default: return { icon: 'question', tone: 'muted', label: `${network} · ${c.status}` };
  }
}

/**
 * The sweep records each channel it didn't send to as "service: reason", joined with " · ".
 * One "Skipped" chip each, with the network's proper name and the reason as its tooltip.
 */
function skippedChips(skipped: string): ChipSpec[] {
  return skipped.split(' · ').map((part): ChipSpec => {
    const m = /^([a-z_]+): (.*)$/s.exec(part);
    return m
      ? { icon: 'skip', tone: 'muted', label: `${networkName(m[1])} · Skipped`, detail: m[2] }
      : { icon: 'skip', tone: 'muted', label: 'Skipped', detail: part };
  });
}

/**
 * The chips for one post. `posting` is whether autopost is on and not paused: a planned post only
 * goes to Buffer then. Off, "Coming up" is what switching on would post, so a planned post shows
 * no chip at all.
 */
function postChips(state: PromotePostState, posting: 'on' | 'off' | 'paused', now: Date): ChipSpec[] {
  if (state.is === 'planned') {
    if (posting === 'off') return [];
    const chips: ChipSpec[] = [posting === 'paused'
      ? { icon: 'clock', tone: 'muted', label: 'Paused', detail: 'Goes to Buffer once posting starts again' }
      : new Date(state.toBufferAt).getTime() <= now.getTime()
        ? { icon: 'clock', tone: 'muted', label: 'To Buffer soon', detail: 'Not in Buffer yet: it goes there within the next six hours' }
        : { icon: 'clock', tone: 'muted', label: `To Buffer ${formatDay(state.toBufferAt)}`, detail: 'Not in Buffer yet' }];
    if (state.lastError) chips.push({ icon: 'alert', tone: 'warning', label: 'Retrying', detail: state.lastError });
    return chips;
  }
  if (state.is === 'sending') return [{ icon: 'send', tone: 'neutral', label: 'Sending to Buffer' }];
  if (state.is === 'failed') return [{ icon: 'cross', tone: 'error', label: 'Failed', detail: state.error ?? 'Didn’t reach Buffer' }];
  return [...state.channels.map(channelChip), ...(state.skipped ? skippedChips(state.skipped) : [])];
}

/** Whether a post needs the artist to look: something failed, or is stuck in Buffer. */
export function needsAttention(state: PromotePostState): boolean {
  if (state.is === 'failed') return true;
  if (state.is === 'planned') return state.lastError !== null;
  if (state.is === 'in_buffer') return state.channels.some(c => c.status === 'error' || c.status === 'draft' || c.status === 'needs_approval');
  return false;
}

export function PromotePostStatus({ state, posting, now = new Date() }: {
  state: PromotePostState;
  posting: 'on' | 'off' | 'paused';
  now?: Date;
}) {
  const chips = postChips(state, posting, now);
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Status" className="flex flex-wrap gap-1.5 pt-0.5">
      {chips.map(chip => <li key={chip.label}><Chip {...chip} /></li>)}
    </ul>
  );
}
