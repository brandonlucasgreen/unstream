import { useState, useEffect, useCallback, useRef } from 'react';
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

/**
 * What the artist typed, as a URL the server will accept — or null if it can't be one.
 *
 * The server requires an http(s) URL, and pasting `subvert.fm/artist/record` (no scheme) is the
 * ordinary way to get that wrong. Assuming https rather than rejecting is safe here: the value
 * is stored and linked, never fetched, and every platform this page lists serves https.
 */
function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    // A bare word is a valid URL to the parser but not an address anyone meant to paste.
    return parsed.hostname.includes('.') ? parsed.toString() : null;
  } catch {
    return null;
  }
}

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

interface CatalogState {
  last_catalogued_at: string | null;
  releases_found: number | null;
  releases_detailed: number | null;
  last_error: string | null;
}

interface CatalogInfo {
  canTrigger: boolean;
  state: CatalogState | null;
  stateError: string | null;
}

/** How long to keep asking before giving up. A full catalogue with prices takes a few minutes. */
const MAX_CATALOG_POLLS = 24;
const CATALOG_POLL_INTERVAL_MS = 5000;

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
  const [catalog, setCatalog] = useState<CatalogInfo | null>(null);

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
      setCatalog(data.catalog ?? null);
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
              {/* Above the list, not below it: scanning is where an artist starts, and on a real
                  catalogue the bottom of the page is a long scroll away. */}
              {catalog?.canTrigger && (
                <CatalogNowPanel
                  slug={slug}
                  token={session?.access_token}
                  catalog={catalog}
                  onFinished={fetchReleases}
                />
              )}

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

function describeCatalogState(state: CatalogState | null): string {
  if (state?.last_error) return `Last run failed: ${state.last_error}`;
  // A state row exists as soon as a crawl is *claimed*, before it runs — so counts are only
  // meaningful once one has finished. Otherwise "0 releases" would be a claim about the
  // catalogue rather than the absence of an answer.
  if (!state?.last_catalogued_at) return 'Never catalogued';
  return `${state.releases_found ?? 0} releases found, ${state.releases_detailed ?? 0} with prices`;
}

/**
 * "Scan my links for releases" — the self-serve version of the admin catalog button.
 *
 * Visibility is decided by the server (`catalog.canTrigger`), not re-derived here, so the
 * rollout gate can't drift out of sync with a copy of the rule in page code. While that gate is
 * admin-only the copy says so plainly rather than pretending to be generally available.
 *
 * Polls for the outcome the same way `AdminCatalogButton` does, and for the same reason: Netlify
 * answers a background invocation with 202 the moment it's queued and discards the handler's
 * response, so the only honest way to report what happened is to ask afterwards.
 */
function CatalogNowPanel({
  slug,
  token,
  catalog,
  onFinished,
}: {
  slug: string;
  token: string | undefined;
  catalog: CatalogInfo;
  onFinished: () => Promise<void> | void;
}) {
  const [status, setStatus] = useState<string>(
    catalog.stateError ?? describeCatalogState(catalog.state)
  );
  const [running, setRunning] = useState(false);
  const lastRunAt = useRef<string | null>(catalog.state?.last_catalogued_at ?? null);
  const lastFailure = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /**
   * Three-valued on purpose: "we couldn't ask" and "never catalogued" are different facts, and
   * one `null` for both makes a failed request render as a confident "Never catalogued".
   */
  const readState = useCallback(async (): Promise<
    { ok: true; state: CatalogState | null } | { ok: false; reason: string }
  > => {
    const response = await fetch(`/api/artist-releases?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, reason: body.error || 'Could not read catalog state' };
    }
    const data = await response.json();
    const info = (data.catalog ?? null) as CatalogInfo | null;
    if (info?.stateError) return { ok: false, reason: info.stateError };
    return { ok: true, state: info?.state ?? null };
  }, [slug, token]);

  const poll = useCallback(() => {
    let attempt = 0;

    function scheduleNext() {
      attempt += 1;
      if (attempt > MAX_CATALOG_POLLS) {
        // Say which it was. "Still running" on top of a run of failed reads would be a guess
        // about the crawl based on no information about the crawl.
        setStatus(lastFailure.current ?? 'Still running — check back shortly');
        setRunning(false);
        return;
      }
      timer.current = setTimeout(async () => {
        try {
          const result = await readState();
          if (!result.ok) {
            // A failed read is not "still running" — but it may be transient, so keep asking
            // and let the message say which of the two we're looking at.
            lastFailure.current = result.reason;
            scheduleNext();
            return;
          }
          lastFailure.current = null;
          const { state } = result;
          if (state?.last_catalogued_at && state.last_catalogued_at !== lastRunAt.current) {
            lastRunAt.current = state.last_catalogued_at;
            setStatus(describeCatalogState(state));
            setRunning(false);
            await onFinished();
            return;
          }
          if (state?.last_error) {
            setStatus(describeCatalogState(state));
            setRunning(false);
            return;
          }
        } catch {
          // A dropped request mid-crawl isn't an answer; keep asking.
          lastFailure.current = 'Could not read catalog state';
        }
        scheduleNext();
      }, CATALOG_POLL_INTERVAL_MS);
    }

    scheduleNext();
  }, [readState, onFinished]);

  const start = useCallback(async () => {
    setRunning(true);
    setStatus('Scanning your links…');
    try {
      const response = await fetch('/api/artist-releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ slug, action: 'catalog' }),
      });
      const body = await response.json().catch(() => ({}));

      // 202 means queued and nothing more. The endpoint reports the refusals it can predict
      // (cataloging disabled, secret missing) as real errors; everything else is settled by
      // polling.
      if (!response.ok && response.status !== 202) {
        setStatus(body.error || 'Could not start');
        setRunning(false);
        return;
      }
      poll();
    } catch {
      setStatus('Could not start');
      setRunning(false);
    }
  }, [slug, token, poll]);

  return (
    <div className="p-4 rounded-xl border border-dashed border-border space-y-2">
      <h2 className="font-display text-base font-semibold text-text-primary">
        Look for releases on your links
      </h2>
      <p className="text-xs text-text-muted">
        Checks the platforms on your profile — Bandcamp, Discogs, Faircamp — and adds anything it
        finds. Some platforms can't be read automatically, so this won't always find everything;
        whatever it misses you can add by hand below.
      </p>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          onClick={start}
          disabled={running || !token}
          className="px-4 py-2 rounded-lg bg-bg-secondary border border-border text-sm text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? 'Scanning…' : 'Scan my links for releases'}
        </button>
        <span className="text-xs text-text-muted">{status}</span>
      </div>
      <p className="text-[11px] text-text-muted pt-1">
        Admin only for now, while we watch how it behaves.
      </p>
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
  onAddLink: (platform: string, url: string) => Promise<boolean>;
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
  onAddLink: (platform: string, url: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(release.title);
  const [releaseDate, setReleaseDate] = useState(release.releaseDate ?? '');
  const [artworkUrl, setArtworkUrl] = useState(release.artworkUrl ?? '');
  const [linkPlatform, setLinkPlatform] = useState<string>(PLATFORM_OPTIONS[0]?.id ?? '');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkStatus, setLinkStatus] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleAddLink() {
    const url = normalizeLinkUrl(linkUrl);
    if (!url) {
      setLinkStatus({ ok: false, message: "That doesn't look like a web address." });
      return;
    }

    setLinkStatus(null);
    const added = await onAddLink(linkPlatform, url);
    // The typed URL is kept on failure. Clearing it optimistically threw away what the artist
    // wrote whenever the save was rejected, so the only way to retry was to type it again.
    if (added) {
      setLinkUrl('');
      setLinkStatus({ ok: true, message: 'Link added.' });
    } else {
      setLinkStatus({ ok: false, message: "Couldn't add that link — see the error above." });
    }
  }

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
            onClick={handleAddLink}
            disabled={linkBusy || !linkUrl.trim()}
            className="px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-text-primary text-xs font-medium hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            {linkBusy ? 'Adding...' : 'Add link'}
          </button>
        </div>
        {/* Beside the field that caused it. The page-level error banner sits above the whole
            release list, which on a real catalogue is far off-screen from the form being used —
            so a rejected link looked exactly like a button that did nothing. */}
        {linkStatus && (
          <p className={`text-xs ${linkStatus.ok ? 'text-green-500' : 'text-red-400'}`}>{linkStatus.message}</p>
        )}
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
