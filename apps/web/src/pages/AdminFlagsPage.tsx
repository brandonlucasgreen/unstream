import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { SkeletonScreen } from '../components/Skeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';
import { getFeatureFlags, updateFeatureFlag, type FeatureFlagMap } from '../services/featureFlags';

/**
 * Labels only. Which flags exist — and whether each is on — comes from the server, so adding a
 * flag to the registry (api/functions/feature-flags.ts) puts a row here with no change to this
 * file. An unknown name falls back to the raw flag name.
 *
 * UNS-215 split `tips` into these two, and they are deliberately independent — neither implies
 * the other. The caption for the artist one says the half that matters: opening onboarding is not
 * the same as letting an artist take money (that still needs admin approval).
 */
const FLAG_COPY: Record<string, { title: string; caption: string }> = {
  tipsArtists: {
    title: 'Tips — artist onboarding',
    caption: 'artists can start Stripe Connect registration; only admin-approved accounts can take money',
  },
  tipsFans: {
    title: 'Tips — fans',
    caption: 'tip buttons on search results, artist pages, SEO pages, and checkout',
  },
};

export function AdminFlagsPage() {
  const { isAdmin, session } = useAuth();
  const [flags, setFlags] = useState<FeatureFlagMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingFlag, setTogglingFlag] = useState<string | null>(null);

  const fetchFlags = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    setError(null);

    try {
      setFlags(await getFeatureFlags(session.access_token));
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'admin.flags.fetchFlags' } });
      setError(err instanceof Error ? err.message : 'Failed to load feature flags.');
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (isAdmin) {
      fetchFlags();
    }
  }, [isAdmin, fetchFlags]);

  const handleToggle = async (flag: string) => {
    if (!session?.access_token) return;
    const previous = flags[flag];
    const next = !previous;

    setTogglingFlag(flag);
    setError(null);
    // Optimistic: the switch moves under the click, and moves back if the write didn't land.
    setFlags(prev => ({ ...prev, [flag]: next }));

    try {
      setFlags(await updateFeatureFlag(session.access_token, flag, next));
    } catch (err) {
      Sentry.captureException(err, { extra: { context: `admin.flags.${flag}` } });
      setFlags(prev => ({ ...prev, [flag]: previous }));
      setError(err instanceof Error ? err.message : `Failed to turn ${flag} ${next ? 'on' : 'off'}.`);
    } finally {
      setTogglingFlag(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-text-muted">Not authorized.</p>
      </div>
    );
  }

  const flagNames = Object.keys(flags);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="px-4 py-8">
        <div className="max-w-3xl mx-auto space-y-8">
          <div>
            <h1 className="font-display text-2xl font-bold text-text-primary">
              Feature Flags
            </h1>
            <p className="text-text-muted text-sm mt-1">
              On means the feature is live to everyone. Off means admins only — which is also
              what every flag reads when the flag store can't be reached.
            </p>
          </div>

          {error && (
            <div role="alert" className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          {loading ? (
            <SkeletonScreen label="Loading feature flags">
              <FormSkeleton sections={1} fields={2} />
            </SkeletonScreen>
          ) : flagNames.length === 0 ? (
            <p className="text-text-muted text-sm">No feature flags are configured.</p>
          ) : (
            <section className="space-y-4" aria-label="Feature flags">
              {flagNames.map(name => {
                const copy = FLAG_COPY[name];
                const enabled = flags[name];
                const label = copy?.title ?? name;

                return (
                  <div
                    key={name}
                    className="p-4 rounded-xl bg-surface border border-border flex items-start justify-between gap-4"
                  >
                    <div>
                      <h2 className="font-semibold text-text-primary">{label}</h2>
                      <p className="text-text-muted text-sm">{copy?.caption ?? 'No description yet.'}</p>
                      <p className="text-text-muted text-xs mt-1 font-mono">{name}</p>
                      <p className={`text-xs mt-1 ${enabled ? 'text-green-400' : 'text-yellow-400'}`}>
                        {enabled ? 'Live to everyone' : 'Admin-only'}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={label}
                      disabled={togglingFlag === name}
                      onClick={() => handleToggle(name)}
                      className={`shrink-0 mt-0.5 relative w-10 h-6 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        enabled ? 'bg-accent-secondary' : 'bg-border'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                          enabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                );
              })}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
