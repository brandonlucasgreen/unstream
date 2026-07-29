import { useState } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import type { PlatformLink } from '../types';
import { getSource } from './ResultCardUtils';

interface AdminRemoveLinkDialogProps {
  artistName: string;
  platform: PlatformLink;
  onClose: () => void;
  /** Called after the suppression is saved, so the card can drop the link. */
  onRemoved: (url: string) => void;
}

/**
 * Admin-only: remove one wrong platform link from a search result.
 *
 * Scope matters. "This artist only" is the default because two real artists can
 * share a name and one of them may genuinely own the page — the same problem the
 * search pipeline's disambiguation exists to solve. "Everywhere" is for links
 * that are wrong under any name.
 */
export function AdminRemoveLinkDialog({ artistName, platform, onClose, onRemoved }: AdminRemoveLinkDialogProps) {
  const { session } = useAuth();
  const [scope, setScope] = useState<'artist' | 'global'>('artist');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = getSource(platform.sourceId);

  const handleRemove = async () => {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/link-suppression', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          url: platform.url,
          source_id: platform.sourceId,
          artist_name: artistName,
          scope,
          reason: reason.trim() || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to remove link (${response.status})`);
      }

      onRemoved(platform.url);
      onClose();
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'admin.removeLink' } });
      setError(err instanceof Error ? err.message : 'Failed to remove link.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="w-full max-w-md rounded-2xl bg-bg-primary border border-border p-5 space-y-4">
        <h2 className="font-display text-lg font-bold text-text-primary">Remove this link</h2>

        <div className="space-y-1 text-sm">
          <p className="text-text-secondary">
            <span className="font-medium text-text-primary">{source.name}</span> on{' '}
            <span className="font-medium text-text-primary">{artistName}</span>
          </p>
          <p className="text-text-muted break-all text-xs">{platform.url}</p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text-primary mb-1">Apply to</legend>
          <label className="flex items-start gap-2 text-sm text-text-secondary cursor-pointer">
            <input
              type="radio"
              name="suppression-scope"
              checked={scope === 'artist'}
              onChange={() => setScope('artist')}
              className="mt-1"
            />
            <span>
              <span className="text-text-primary">{artistName} only</span>
              <span className="block text-xs text-text-muted">
                Another artist with the same name keeps this link.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-text-secondary cursor-pointer">
            <input
              type="radio"
              name="suppression-scope"
              checked={scope === 'global'}
              onChange={() => setScope('global')}
              className="mt-1"
            />
            <span>
              <span className="text-text-primary">Every artist</span>
              <span className="block text-xs text-text-muted">
                This URL never appears in any search result.
              </span>
            </span>
          </label>
        </fieldset>

        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary" htmlFor="suppression-reason">
            Reason (optional)
          </label>
          <input
            id="suppression-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Not the real artist"
            className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
          />
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <button
            onClick={handleRemove}
            disabled={saving}
            className="px-4 py-2 rounded-xl bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? 'Removing...' : 'Remove link'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-surface border border-border text-text-primary hover:bg-surface-secondary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
