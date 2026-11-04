import { networkName } from '../../../../api/shared/autopost-networks';
import type { PromoteBuffer, PromoteChannel } from '../services/promote';
import { BUFFER_CHANNELS_URL } from '../data/buffer';

// Connecting Buffer and choosing where posts go, shared by the Promote page's Autopost tab
// (ArtistPromotePage) and its Campaigns tab (PromoteCampaignsPage). Both need the whole thing,
// because either may be where an artist starts (Brandon, 2026-11-03), and neither should send
// them to the other to connect an account.
//
// **The connection and the organization are the artist's; the channels are the feature's.** One
// Buffer login and one workspace per artist, kept on the promote settings row; which channels
// autopost posts to and which a given campaign posts to are separate choices, so this component
// is told the channels to show ticked and reports changes back.

const PRIMARY_BUTTON = 'px-3 py-2 text-sm rounded-lg bg-accent-primary text-accent-foreground disabled:opacity-50';
const SECONDARY_BUTTON = 'px-3 py-2 text-sm rounded-lg border border-border hover:bg-bg-secondary disabled:opacity-50';

export interface PromoteBufferChannelsProps {
  buffer: PromoteBuffer;
  /** The organization chosen in the form, which may not yet be the one Buffer was asked about. */
  organizationId: string | null;
  channelIds: string[];
  busy: boolean;
  /** What these channels are for, in a sentence: 'autopost', 'this campaign'. */
  what: string;
  onConnect: () => void;
  /** Read Buffer again after the artist connects channels there. */
  onCheckAgain: () => void;
  onChange: (next: { organizationId: string | null; channelIds: string[] }) => void;
}

export function PromoteBufferChannels({
  buffer, organizationId, channelIds, busy, what, onConnect, onCheckAgain, onChange,
}: PromoteBufferChannelsProps) {
  if (!buffer.connected) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-text-secondary">
          <span className="font-medium text-text-primary">New to Buffer?</span> You can make a free account on the next
          screen. Then connect your social channels in Buffer, since Unstream can only post to channels connected there.
        </p>
        <button type="button" disabled={busy} onClick={onConnect} className={PRIMARY_BUTTON}>Connect Buffer</button>
      </div>
    );
  }

  if (buffer.organizations.length === 0) return <NoChannels busy={busy} onCheckAgain={onCheckAgain} what={what} />;

  const supported = buffer.channels.filter(c => c.supported);
  return (
    <div className="space-y-3">
      {buffer.organizations.length > 1 && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          Buffer organization
          <select
            value={organizationId ?? ''}
            // Channel ids belong to one organization, so moving starts the choice again.
            onChange={e => onChange({ organizationId: e.target.value || null, channelIds: [] })}
            className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
          >
            <option value="">Choose…</option>
            {buffer.organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      )}
      {organizationId && organizationId !== buffer.organizationId && (
        <p className="text-xs text-text-muted">Save to see this organization’s channels.</p>
      )}
      {organizationId && organizationId === buffer.organizationId && (
        supported.length === 0 ? (
          <NoChannels busy={busy} onCheckAgain={onCheckAgain} what={what} hasOthers={buffer.channels.length > 0} />
        ) : (
          <PromoteChannelPicker
            channels={buffer.channels}
            channelIds={channelIds}
            what={what}
            onChange={ids => onChange({ organizationId, channelIds: ids })}
          />
        )
      )}
    </div>
  );
}

/**
 * Which of the artist's Buffer channels this thing posts to. On its own, because autopost ticks
 * them once for good and a campaign ticks its own each time it's planned.
 */
export function PromoteChannelPicker({ channels, channelIds, what, onChange }: {
  channels: PromoteChannel[];
  channelIds: string[];
  what: string;
  onChange: (channelIds: string[]) => void;
}) {
  const ticked = new Set(channelIds);
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm text-text-secondary mb-1">Channels</legend>
      {channels.filter(c => c.supported).map(c => (
        <label key={c.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ticked.has(c.id)}
            onChange={e => onChange(e.target.checked ? [...channelIds, c.id] : channelIds.filter(id => id !== c.id))}
          />
          {c.name} <span className="text-text-muted">· {networkName(c.service)}</span>
        </label>
      ))}
      {/* Unstream's choice, not Buffer's: these posts are text with an image, so networks that
          need a video or extra setup aren't offered. Named once, out of the way, by network
          only (Brandon, 2026-10-30: the longer line was too much). */}
      {channels.some(c => !c.supported) && (
        <p className="pt-1 text-xs text-text-muted">
          Not available for {what}:{' '}
          {[...new Set(channels.filter(c => !c.supported).map(c => networkName(c.service)))].join(', ')}
        </p>
      )}
      <a href={BUFFER_CHANNELS_URL} target="_blank" rel="noopener noreferrer" className="inline-block pt-1 text-xs text-link hover:underline">
        Connect another social channel ↗
      </a>
    </fieldset>
  );
}

/**
 * A connected Buffer with no social accounts to post to. Signing up through Buffer's own screen
 * during the connection makes an account with none, so this is where a new Buffer user lands:
 * send them to connect one there, then check again.
 */
function NoChannels({ busy, onCheckAgain, what, hasOthers = false }: { busy: boolean; onCheckAgain: () => void; what: string; hasOthers?: boolean }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-bg-primary p-3">
      <p className="text-sm text-text-primary">
        {hasOthers
          ? `None of the channels connected in Buffer are ones ${what} can post to.`
          : 'Your Buffer doesn’t have any social channels connected yet.'}
      </p>
      <p className="text-sm text-text-secondary">
        Connect your Instagram, TikTok, Facebook, Threads, Bluesky, Mastodon, LinkedIn or Substack in Buffer first, then come
        back here and check again.
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={BUFFER_CHANNELS_URL} target="_blank" rel="noopener noreferrer" className={PRIMARY_BUTTON}>
          Connect social channels in Buffer ↗
        </a>
        <button type="button" disabled={busy} onClick={onCheckAgain} className={SECONDARY_BUTTON}>Check again</button>
      </div>
    </div>
  );
}
