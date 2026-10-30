import { networkName } from '../../../../api/shared/autopost-networks';
import type { PromoteChannelState, PromotePostState } from '../services/promote';

// Where one release autopost post stands, under it in the Promote page's "Coming up" and "Recent":
// not in Buffer yet, on its way, refused, or in Buffer with each channel's own status (scheduled,
// posted, failed there). Built by api/functions/autopost-schedule-view.ts.

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

const MUTED = 'text-text-muted';

/**
 * The sweep records why a channel didn't get a post as "service: reason", joined with " · ".
 * Shown with each network's proper name.
 */
function readableReasons(error: string): string {
  return error.split(' · ').map(part => {
    const m = /^([a-z_]+): (.*)$/s.exec(part);
    return m ? `${networkName(m[1])}: ${m[2]}` : part;
  }).join(' · ');
}

function channelLine(c: PromoteChannelState): { text: string; tone: string } {
  switch (c.status) {
    case 'scheduled': return { text: c.dueAt ? `Scheduled for ${formatWhen(c.dueAt)}` : 'Scheduled', tone: 'text-text-secondary' };
    case 'sending': return { text: 'Publishing now', tone: 'text-text-secondary' };
    case 'sent': return { text: 'Posted', tone: 'text-success' };
    case 'error': return { text: c.error ? `Failed to post: ${c.error}` : 'Failed to post', tone: 'text-error' };
    case 'draft': return { text: 'A draft in Buffer: it won’t post until it’s scheduled there', tone: 'text-warning' };
    case 'needs_approval': return { text: 'Waiting for approval in Buffer', tone: 'text-warning' };
    case 'missing': return { text: 'No longer in Buffer', tone: MUTED };
    case 'unknown': return { text: 'In Buffer (couldn’t check its status just now)', tone: MUTED };
    default: return { text: `In Buffer (${c.status})`, tone: MUTED };
  }
}

/**
 * `posting` is whether autopost is on and not paused: a planned post only goes to Buffer then.
 * Off, "Coming up" is what switching on would post, so a planned post says nothing at all.
 */
export function PromotePostStatus({ state, posting, now = new Date() }: {
  state: PromotePostState;
  posting: 'on' | 'off' | 'paused';
  now?: Date;
}) {
  if (state.is === 'planned') {
    if (posting === 'off') return null;
    const due = new Date(state.toBufferAt).getTime() <= now.getTime();
    const when = posting === 'paused'
      ? 'waiting for posting to start again'
      : due ? 'goes to Buffer within the next six hours' : `goes to Buffer ${formatDay(state.toBufferAt)}`;
    return (
      <div className="text-xs">
        <p className={MUTED}>Not in Buffer yet · {when}</p>
        {state.lastError && <p className="text-warning">The last try didn’t reach Buffer, so it will try again: {readableReasons(state.lastError)}</p>}
      </div>
    );
  }
  if (state.is === 'sending') return <p className={`text-xs ${MUTED}`}>Sending to Buffer…</p>;
  if (state.is === 'failed') {
    return <p className="text-xs text-error">Didn’t reach Buffer{state.error ? `: ${readableReasons(state.error)}` : ''}</p>;
  }
  return (
    <ul className="text-xs space-y-0.5">
      {state.channels.map(c => {
        const line = channelLine(c);
        return (
          <li key={c.channelId} className={line.tone}>
            {c.service ? `${networkName(c.service)}: ` : ''}{line.text}
            {c.status === 'sent' && c.link && (
              <>
                {' · '}
                <a href={c.link} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">View ↗</a>
              </>
            )}
          </li>
        );
      })}
      {state.skipped && <li className={MUTED}>Not sent everywhere: {readableReasons(state.skipped)}</li>}
    </ul>
  );
}
