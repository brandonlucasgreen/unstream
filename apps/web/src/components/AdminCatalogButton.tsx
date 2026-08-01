import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * Admin-only "Catalog releases now" control on an artist page.
 *
 * Cataloguing is otherwise triggered only by a fan saving an artist or a search resolving one,
 * which is deliberate — it's what keeps the crawl small. This is the same escape hatch as
 * `npm run catalog:artist`, without a terminal.
 *
 * Lives in React rather than in the `artist-page-static` edge function because that function
 * now serves **crawlers only** — real browsers get the SPA (PR #369). A control rendered there
 * would be delivered to Googlebot and to nobody else.
 *
 * `isAdmin` decides whether this renders, matching how the rest of the app gates admin UI
 * (App.tsx). That is presentation only: `/api/admin/catalog-artist` checks the caller against
 * ADMIN_EMAIL server-side on every request, which is the check that actually matters.
 */

interface CatalogState {
  last_catalogued_at: string | null;
  releases_found: number | null;
  releases_detailed: number | null;
  last_error: string | null;
}

type ReadResult = { ok: true; state: CatalogState | null } | { ok: false; reason: string };

/** How long to keep asking before giving up. A full catalogue with prices takes a few minutes. */
const MAX_POLLS = 24;
const POLL_INTERVAL_MS = 5000;

function describe(state: CatalogState | null): string {
  if (state?.last_error) return `Last run failed: ${state.last_error}`;
  // A state row exists as soon as a crawl is *claimed*, before it runs — so counts are only
  // meaningful once one has finished. Otherwise "0 releases" would be a claim about the artist
  // rather than the absence of an answer.
  if (!state?.last_catalogued_at) return 'Never catalogued';
  return `${state.releases_found ?? 0} releases, ${state.releases_detailed ?? 0} with prices`;
}

export function AdminCatalogButton({ artistId }: { artistId: string }) {
  const { isAdmin, session } = useAuth();
  const token = session?.access_token;

  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const lastRunAt = useRef<string | null>(null);
  /** Why the last read failed, so an exhausted poll can report that instead of guessing. */
  const lastFailure = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Three-valued on purpose. "We couldn't ask" and "this artist has never been catalogued" are
   * different facts, and a single `null` for both makes a failed request render as a confident
   * "Never catalogued" — the exact thing this control exists to stop being ambiguous.
   */
  const readState = useCallback(async (): Promise<ReadResult> => {
    const response = await fetch(`/api/admin/catalog-artist?artistId=${encodeURIComponent(artistId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, reason: body.error || 'Could not read catalog state' };
    }
    const data = await response.json();
    return { ok: true, state: (data.state as CatalogState | null) ?? null };
  }, [artistId, token]);

  useEffect(() => {
    if (!isAdmin || !token) return;
    let cancelled = false;

    readState()
      .then(result => {
        if (cancelled) return;
        if (!result.ok) {
          setStatus(result.reason);
          return;
        }
        lastRunAt.current = result.state?.last_catalogued_at ?? null;
        setStatus(describe(result.state));
      })
      .catch(() => {
        if (!cancelled) setStatus('Could not read catalog state');
      });

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [isAdmin, token, readState]);

  /**
   * Ask for the outcome until it arrives.
   *
   * A hoisted function declaration rather than a self-referencing `const`, which would read its
   * own binding inside its initializer — legal at runtime but genuinely confusing, and the
   * linter is right to refuse it.
   */
  const poll = useCallback(() => {
    let attempt = 0;

    function scheduleNext() {
      attempt += 1;
      if (attempt > MAX_POLLS) {
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
            setStatus(describe(state));
            setRunning(false);
            return;
          }
          if (state?.last_error) {
            setStatus(describe(state));
            setRunning(false);
            return;
          }
        } catch {
          // A dropped request mid-crawl isn't an answer; keep asking.
          lastFailure.current = 'Could not read catalog state';
        }
        scheduleNext();
      }, POLL_INTERVAL_MS);
    }

    scheduleNext();
  }, [readState]);

  const start = useCallback(async () => {
    setRunning(true);
    setStatus('Cataloguing…');
    try {
      const response = await fetch('/api/admin/catalog-artist', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistId }),
      });
      const body = await response.json().catch(() => ({}));

      // 202 means queued, nothing more: Netlify answers it the instant a background
      // invocation is accepted and discards whatever the handler returns. The endpoint checks
      // the refusals it can predict (non-production context, missing secret) and reports them
      // as real errors above; everything else is settled by polling.
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
  }, [artistId, token, poll]);

  if (!isAdmin || !token) return null;

  return (
    <div className="mt-8 p-3 rounded-xl border border-dashed border-border text-center">
      <button
        onClick={start}
        disabled={running}
        className="px-4 py-2 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
      >
        Catalog releases now
      </button>
      <p className="mt-2 text-xs text-text-muted">{status || 'Admin only'}</p>
    </div>
  );
}
