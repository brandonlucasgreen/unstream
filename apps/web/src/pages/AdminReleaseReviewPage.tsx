import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { SkeletonScreen } from '../components/Skeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';
import { PlatformIcon } from '../components/PlatformIcon';
import { PLATFORMS } from '../../../../api/shared/platform-registry';
import { formatReleaseDate, releaseTypeLabel } from '../../../../api/shared/release-display';
import type { SourceId } from '../types';

interface ReleaseReviewItem {
  id: string;
  title: string;
  slug: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string | null;
  artworkUrl: string | null;
  artistName: string;
  artistSlug: string;
  platforms: string[];
}

interface ReviewPair {
  primary: ReleaseReviewItem;
  counterpart: ReleaseReviewItem | null;
}

/**
 * The human backstop for tier-3 dedup (spec §4, §11). Ingest never auto-merges a fuzzy title
 * match — it flags both sides via `needs_review` and asks here instead, because a false merge
 * would silently assert two different albums are one, and nobody would ever notice.
 *
 * Each pair gets three possible answers: "not a duplicate" (dismiss, both sides stop being
 * flagged), or "same release" pointed at whichever side should survive (merge moves the other
 * side's sources over, then removes the now-empty duplicate row).
 */
export function AdminReleaseReviewPage() {
  const { isAdmin, session } = useAuth();
  const [pairs, setPairs] = useState<ReviewPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/release-review', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to fetch (${response.status})`);
      }

      const data = await response.json();
      setPairs(data.pairs || []);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'admin.releaseReview.fetchQueue' } });
      setError(err instanceof Error ? err.message : 'Failed to load the review queue.');
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (isAdmin) fetchQueue();
  }, [isAdmin, fetchQueue]);

  const runAction = async (key: string, body: Record<string, unknown>) => {
    if (!session?.access_token) return;
    setActionLoading(key);
    setError(null);

    try {
      const response = await fetch('/api/admin/release-review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Action failed (${response.status})`);
      }

      await fetchQueue();
    } catch (err) {
      Sentry.captureException(err, { extra: { context: `admin.releaseReview.${body.action}` } });
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setActionLoading(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-text-muted">Not authorized.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />
      <div className="px-4 py-8">
        <div className="max-w-3xl mx-auto space-y-8">
          <div>
            <h1 className="font-display text-2xl font-bold text-text-primary">Release Review</h1>
            <p className="text-text-muted text-sm mt-1">
              Releases the catalog wasn't confident enough to merge on its own — a title close
              enough to another one under the same artist to flag for a human, rather than guess.
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          {loading ? (
            <SkeletonScreen label="Loading flagged releases">
              <FormSkeleton sections={2} fields={2} />
            </SkeletonScreen>
          ) : pairs.length === 0 ? (
            <p className="text-text-muted text-sm">Nothing flagged for review right now.</p>
          ) : (
            <div className="space-y-4">
              {pairs.map(pair => (
                <ReviewPairCard
                  key={pair.primary.id}
                  pair={pair}
                  actionLoading={actionLoading}
                  onDismiss={releaseId => runAction(`dismiss-${releaseId}`, { action: 'dismiss', releaseId })}
                  onMerge={(keepId, dropId) => runAction(`merge-${keepId}`, { action: 'merge', keepId, dropId })}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReleaseSummary({ item }: { item: ReleaseReviewItem }) {
  const date = formatReleaseDate(item.releaseDate, item.datePrecision);
  const type = releaseTypeLabel(item.releaseType, item.platforms);
  const meta = [type, date].filter(Boolean).join(' · ');

  return (
    <div className="flex items-start gap-3">
      {item.artworkUrl ? (
        <img
          src={item.artworkUrl}
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
      <div className="min-w-0">
        <a
          href={`/a/${encodeURIComponent(item.artistSlug)}/${encodeURIComponent(item.slug)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-text-primary truncate hover:underline block"
        >
          {item.title}
        </a>
        {meta && <p className="text-xs text-text-muted">{meta}</p>}
        {item.platforms.length > 0 && (
          <div className="flex items-center gap-1 mt-1">
            {item.platforms.map(p => (
              <PlatformIcon
                key={p}
                sourceId={p as SourceId}
                color={PLATFORMS[p]?.color ?? '#888'}
                emoji={PLATFORMS[p]?.icon ?? '🔗'}
                className="w-3.5 h-3.5"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewPairCard({
  pair,
  actionLoading,
  onDismiss,
  onMerge,
}: {
  pair: ReviewPair;
  actionLoading: string | null;
  onDismiss: (releaseId: string) => void;
  onMerge: (keepId: string, dropId: string) => void;
}) {
  const { primary, counterpart } = pair;
  const busy = (key: string) => actionLoading === key;

  return (
    <div className="p-4 rounded-xl bg-surface border border-border space-y-4">
      <p className="text-xs text-text-secondary font-medium">{primary.artistName}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <ReleaseSummary item={primary} />
          {counterpart && (
            <button
              onClick={() => onMerge(primary.id, counterpart.id)}
              disabled={busy(`merge-${primary.id}`) || busy(`merge-${counterpart.id}`)}
              className="w-full px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs font-medium hover:bg-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy(`merge-${primary.id}`) ? 'Merging...' : 'Same release — keep this one'}
            </button>
          )}
        </div>

        {counterpart && (
          <div className="space-y-2">
            <ReleaseSummary item={counterpart} />
            <button
              onClick={() => onMerge(counterpart.id, primary.id)}
              disabled={busy(`merge-${primary.id}`) || busy(`merge-${counterpart.id}`)}
              className="w-full px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs font-medium hover:bg-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy(`merge-${counterpart.id}`) ? 'Merging...' : 'Same release — keep this one'}
            </button>
          </div>
        )}
      </div>

      {!counterpart && (
        <p className="text-xs text-text-muted">
          Its suspected duplicate is no longer on file — nothing left to compare against.
        </p>
      )}

      <button
        onClick={() => onDismiss(primary.id)}
        disabled={busy(`dismiss-${primary.id}`)}
        className="px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-text-primary text-sm font-medium hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy(`dismiss-${primary.id}`) ? 'Working...' : 'Not a duplicate'}
      </button>
    </div>
  );
}
