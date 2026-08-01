import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { PageSkeleton } from '../components/PageSkeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';
import { PlatformIcon } from '../components/PlatformIcon';
import { PLATFORMS } from '../../../../api/shared/platform-registry';
import { formatReleaseDate } from '../../../../api/shared/release-display';
import { sources } from '../services/sources';
import type { SourceId } from '../types';

const PLATFORM_OPTIONS = (Object.values(sources) as { id: SourceId; name: string }[])
  .filter(s => s.id !== 'other')
  .map(s => ({ id: s.id, name: s.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

const RELEASE_TYPES = ['album', 'ep', 'single', 'compilation', 'live', 'remix', 'other'] as const;

interface OwnerRelease {
  id: string;
  title: string;
  slug: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string | null;
  artworkUrl: string | null;
  isHidden: boolean;
  needsReview: boolean;
  flaggedAgainst: { id: string; title: string } | null;
  sources: { platform: string; url: string }[];
}

/**
 * The artist-facing half of release curation (spec §11) — reachable from `ArtistEditPage` via
 * "Manage releases". Ingest never merges a suspected duplicate or overwrites a curated field
 * (see `db.ts`'s `updateArtistReleaseFields`/`addArtistReleaseLink`); this page is where an
 * artist, who knows their own catalog better than any auto-matching ever will, corrects it.
 */
export function ArtistReleasesPage() {
  const { slug } = useParams<{ slug: string }>();
  const { session } = useAuth();
  const [releases, setReleases] = useState<OwnerRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const fetchReleases = useCallback(async () => {
    if (!session?.access_token || !slug) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/artist-releases?slug=${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to fetch (${response.status})`);
      }

      const data = await response.json();
      setReleases(data.releases || []);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'artistReleases.fetch' } });
      setError(err instanceof Error ? err.message : 'Failed to load releases.');
    } finally {
      setLoading(false);
    }
  }, [session?.access_token, slug]);

  useEffect(() => {
    fetchReleases();
  }, [fetchReleases]);

  const runAction = useCallback(
    async (key: string, body: Record<string, unknown>): Promise<boolean> => {
      if (!session?.access_token || !slug) return false;
      setActionLoading(key);
      setError(null);

      try {
        const response = await fetch('/api/artist-releases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ slug, ...body }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Action failed (${response.status})`);
        }

        await fetchReleases();
        return true;
      } catch (err) {
        Sentry.captureException(err, { extra: { context: `artistReleases.${body.action}` } });
        setError(err instanceof Error ? err.message : 'Action failed.');
        return false;
      } finally {
        setActionLoading(null);
      }
    },
    [session?.access_token, slug, fetchReleases]
  );

  if (!slug) return null;

  return (
    <div className="min-h-screen">
      <Header />
      <div className="px-4 py-8">
        <div className="max-w-2xl mx-auto space-y-6">
          <div>
            <Link
              to={`/artist-edit/${slug}`}
              className="text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              &larr; Back to profile
            </Link>
            <h1 className="font-display text-2xl font-bold text-text-primary mt-1">Manage Releases</h1>
            <p className="text-text-muted text-sm mt-1">
              Hide anything that isn't yours, fix a title or date, merge a duplicate, or add
              something we missed.
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          {loading ? (
            <PageSkeleton label="Loading releases">
              <FormSkeleton sections={2} fields={2} />
            </PageSkeleton>
          ) : (
            <>
              <button
                onClick={() => setShowAddForm(v => !v)}
                className="px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-text-primary text-sm font-medium hover:bg-bg-hover transition-colors"
              >
                {showAddForm ? 'Cancel' : '+ Add a release we missed'}
              </button>

              {showAddForm && (
                <AddReleaseForm
                  busy={actionLoading === 'create'}
                  onCreate={async input => {
                    const created = await runAction('create', { action: 'create', ...input });
                    if (created) setShowAddForm(false);
                  }}
                />
              )}

              {releases.length === 0 ? (
                <p className="text-text-muted text-sm">No releases catalogued yet.</p>
              ) : (
                <div className="space-y-3">
                  {releases.map(release => (
                    <ReleaseCard
                      key={release.id}
                      release={release}
                      editing={editingId === release.id}
                      actionLoading={actionLoading}
                      onToggleEdit={() => setEditingId(editingId === release.id ? null : release.id)}
                      onHide={() =>
                        runAction(`hide-${release.id}`, {
                          action: release.isHidden ? 'unhide' : 'hide',
                          releaseId: release.id,
                        })
                      }
                      onDismiss={() => runAction(`dismiss-${release.id}`, { action: 'dismiss', releaseId: release.id })}
                      onMerge={(keepId, dropId) => runAction(`merge-${keepId}`, { action: 'merge', keepId, dropId })}
                      onUpdate={async patch => {
                        const saved = await runAction(`update-${release.id}`, {
                          action: 'update',
                          releaseId: release.id,
                          ...patch,
                        });
                        if (saved) setEditingId(null);
                      }}
                      onAddLink={(platform, url) =>
                        runAction(`addlink-${release.id}`, { action: 'addLink', releaseId: release.id, platform, url })
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PlatformBadges({ items }: { items: { platform: string; url: string }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex items-center gap-2 mt-1.5">
      {items.map(s => (
        <a
          key={s.platform}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          title={PLATFORMS[s.platform]?.name ?? s.platform}
        >
          <PlatformIcon
            sourceId={s.platform as SourceId}
            color={PLATFORMS[s.platform]?.color ?? '#888'}
            emoji={PLATFORMS[s.platform]?.icon ?? '🔗'}
            className="w-4 h-4"
          />
        </a>
      ))}
    </div>
  );
}

function ReleaseCard({
  release,
  editing,
  actionLoading,
  onToggleEdit,
  onHide,
  onDismiss,
  onMerge,
  onUpdate,
  onAddLink,
}: {
  release: OwnerRelease;
  editing: boolean;
  actionLoading: string | null;
  onToggleEdit: () => void;
  onHide: () => void;
  onDismiss: () => void;
  onMerge: (keepId: string, dropId: string) => void;
  onUpdate: (patch: { title?: string; releaseDate?: string | null; artworkUrl?: string | null }) => void;
  onAddLink: (platform: string, url: string) => void;
}) {
  const busy = (key: string) => actionLoading === key;
  const date = formatReleaseDate(release.releaseDate, release.datePrecision);
  const type = release.releaseType === 'other' ? '' : release.releaseType.charAt(0).toUpperCase() + release.releaseType.slice(1);
  const meta = [type, date].filter(Boolean).join(' · ');

  return (
    <div className={`p-4 rounded-xl bg-surface border border-border space-y-3 ${release.isHidden ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        {release.artworkUrl ? (
          <img
            src={release.artworkUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="w-12 h-12 rounded-md object-cover shrink-0 bg-bg-secondary"
          />
        ) : (
          <div className="w-12 h-12 rounded-md shrink-0 bg-bg-secondary flex items-center justify-center text-xl">
            💿
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-text-primary truncate">{release.title}</p>
            {release.isHidden && (
              <span className="text-[10px] font-bold uppercase tracking-wide text-text-muted shrink-0">Hidden</span>
            )}
            {release.needsReview && (
              <span className="text-[10px] font-bold uppercase tracking-wide text-yellow-500 shrink-0">Needs review</span>
            )}
          </div>
          {meta && <p className="text-xs text-text-muted">{meta}</p>}
          <PlatformBadges items={release.sources} />
        </div>
      </div>

      {release.needsReview && release.flaggedAgainst && (
        <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm space-y-2">
          <p className="text-text-secondary">
            Possible duplicate of <span className="font-medium">{release.flaggedAgainst.title}</span>.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onDismiss}
              disabled={busy(`dismiss-${release.id}`)}
              className="px-3 py-1 rounded-lg bg-bg-secondary border border-border text-text-primary text-xs font-medium hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              {busy(`dismiss-${release.id}`) ? 'Working...' : 'Not a duplicate'}
            </button>
            <button
              onClick={() => onMerge(release.id, release.flaggedAgainst!.id)}
              disabled={busy(`merge-${release.id}`)}
              className="px-3 py-1 rounded-lg bg-green-600 text-white text-xs font-medium hover:bg-green-500 transition-colors disabled:opacity-50"
            >
              {busy(`merge-${release.id}`) ? 'Merging...' : 'Same release — keep this one'}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onHide}
          disabled={busy(`hide-${release.id}`)}
          className="px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-text-primary text-xs font-medium hover:bg-bg-hover transition-colors disabled:opacity-50"
        >
          {busy(`hide-${release.id}`) ? 'Working...' : release.isHidden ? 'Unhide' : 'Hide'}
        </button>
        <button
          onClick={onToggleEdit}
          className="px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-text-primary text-xs font-medium hover:bg-bg-hover transition-colors"
        >
          {editing ? 'Cancel' : 'Edit / add link'}
        </button>
      </div>

      {editing && (
        <EditReleaseForm
          release={release}
          busy={busy(`update-${release.id}`)}
          linkBusy={busy(`addlink-${release.id}`)}
          onSave={onUpdate}
          onAddLink={onAddLink}
        />
      )}
    </div>
  );
}

function EditReleaseForm({
  release,
  busy,
  linkBusy,
  onSave,
  onAddLink,
}: {
  release: OwnerRelease;
  busy: boolean;
  linkBusy: boolean;
  onSave: (patch: { title?: string; releaseDate?: string | null; artworkUrl?: string | null }) => void;
  onAddLink: (platform: string, url: string) => void;
}) {
  const [title, setTitle] = useState(release.title);
  const [releaseDate, setReleaseDate] = useState(release.releaseDate ?? '');
  const [artworkUrl, setArtworkUrl] = useState(release.artworkUrl ?? '');
  const [linkPlatform, setLinkPlatform] = useState<string>(PLATFORM_OPTIONS[0]?.id ?? '');
  const [linkUrl, setLinkUrl] = useState('');

  return (
    <div className="pt-3 border-t border-border space-y-4">
      <div className="space-y-2">
        <label className="block text-xs font-medium text-text-muted">Title</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
        />
        <label className="block text-xs font-medium text-text-muted">Release date</label>
        <input
          type="date"
          value={releaseDate}
          onChange={e => setReleaseDate(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
        />
        <label className="block text-xs font-medium text-text-muted">Artwork URL</label>
        <input
          type="text"
          value={artworkUrl}
          onChange={e => setArtworkUrl(e.target.value)}
          placeholder="https://..."
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
        />
        <button
          onClick={() =>
            onSave({
              title: title.trim() !== release.title ? title.trim() : undefined,
              releaseDate: releaseDate !== (release.releaseDate ?? '') ? releaseDate || null : undefined,
              artworkUrl: artworkUrl !== (release.artworkUrl ?? '') ? artworkUrl || null : undefined,
            })
          }
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs font-medium hover:bg-green-500 transition-colors disabled:opacity-50"
        >
          {busy ? 'Saving...' : 'Save changes'}
        </button>
      </div>

      <div className="space-y-2">
        <label className="block text-xs font-medium text-text-muted">Add a platform link</label>
        <div className="flex flex-wrap gap-2">
          <select
            value={linkPlatform}
            onChange={e => setLinkPlatform(e.target.value)}
            className="px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
          >
            {PLATFORM_OPTIONS.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={linkUrl}
            onChange={e => setLinkUrl(e.target.value)}
            placeholder="https://..."
            className="flex-1 min-w-[160px] px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
          />
          <button
            onClick={() => {
              if (!linkUrl.trim()) return;
              onAddLink(linkPlatform, linkUrl.trim());
              setLinkUrl('');
            }}
            disabled={linkBusy || !linkUrl.trim()}
            className="px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-text-primary text-xs font-medium hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            {linkBusy ? 'Adding...' : 'Add link'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddReleaseForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (input: { title: string; releaseType: string; releaseDate: string | null; platform: string; url: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [releaseType, setReleaseType] = useState<string>('album');
  const [releaseDate, setReleaseDate] = useState('');
  const [platform, setPlatform] = useState<string>(PLATFORM_OPTIONS[0]?.id ?? '');
  const [url, setUrl] = useState('');

  const canSubmit = title.trim().length > 0 && url.trim().length > 0;

  return (
    <div className="p-4 rounded-xl bg-surface border border-border space-y-3">
      <label className="block text-xs font-medium text-text-muted">Title</label>
      <input
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Release title"
        className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
      />

      <div className="flex flex-wrap gap-2">
        <select
          value={releaseType}
          onChange={e => setReleaseType(e.target.value)}
          className="px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
        >
          {RELEASE_TYPES.map(t => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={releaseDate}
          onChange={e => setReleaseDate(e.target.value)}
          className="px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          value={platform}
          onChange={e => setPlatform(e.target.value)}
          className="px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
        >
          {PLATFORM_OPTIONS.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://..."
          className="flex-1 min-w-[160px] px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
        />
      </div>

      <button
        onClick={() =>
          onCreate({ title: title.trim(), releaseType, releaseDate: releaseDate || null, platform, url: url.trim() })
        }
        disabled={busy || !canSubmit}
        className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-500 transition-colors disabled:opacity-50"
      >
        {busy ? 'Adding...' : 'Add release'}
      </button>
    </div>
  );
}
