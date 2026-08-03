// Duplicate artist rows, on the Artist Review page.
//
// The same artist can hold two rows with two slugs and two pages — often a near-empty shadow of a
// claimed profile, which is what artists write in about. Merging is irreversible and touches six
// tables, so this deliberately makes it a two-step action: Preview runs the merge as a dry run and
// shows exactly what it would write, and only then does Apply appear.
//
// The evidence badge is the safety mechanism, not decoration. A pair that merely *looks* alike is
// never mergeable here: `Tiger Cub` and `Tigercub` are different bands, and so are `Honeycrush` and
// `Honey Crush`. The server re-derives the evidence on every request, so a stale page cannot talk it
// into a merge it wouldn't otherwise allow.

import { useState, useEffect, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';

interface DuplicateRow {
  id: string;
  slug: string;
  name: string;
  matchConfidence: string;
  linkCount: number;
  releaseCount: number;
  hasProfile: boolean;
}

interface DuplicatePair {
  key: string;
  winner: DuplicateRow;
  loser: DuplicateRow;
  evidence: 'provenance' | 'release-overlap' | 'accent-fold' | 'name-only';
  sharedTitles: string[];
  blockers: string[];
}

interface ReslugCandidate {
  id: string;
  name: string;
  from: string;
  to: string;
}

interface MergeStep {
  table: string;
  action: string;
  count: number;
}

interface MergeResult {
  ok: boolean;
  dryRun: boolean;
  steps: MergeStep[];
  refused?: string;
}

const EVIDENCE_LABEL: Record<DuplicatePair['evidence'], string> = {
  provenance: 'same artist by construction — the loser’s name is the normalised winner name',
  'release-overlap': 'shares release titles',
  'accent-fold': 'identical once accents are folded',
  'name-only': 'names look alike and nothing corroborates it',
};

const EVIDENCE_STYLE: Record<DuplicatePair['evidence'], string> = {
  provenance: 'bg-green-500/10 text-green-400 border-green-500/30',
  'release-overlap': 'bg-green-500/10 text-green-400 border-green-500/30',
  'accent-fold': 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  'name-only': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
};

function RowSummary({ row, keep }: { row: DuplicateRow; keep: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className={`text-xs font-mono uppercase ${keep ? 'text-green-400' : 'text-red-400'}`}>
        {keep ? 'keep' : 'drop'}
      </span>
      <span className="text-text-primary font-medium">{row.name}</span>
      <span className="text-text-muted">/{row.slug}</span>
      <span className="text-text-muted text-xs">
        {row.linkCount} links · {row.releaseCount} releases
        {row.matchConfidence === 'claimed' && ' · CLAIMED'}
        {row.hasProfile && ' · profile'}
      </span>
    </div>
  );
}

export function AdminDuplicateArtists({ session }: { session: Session | null }) {
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [reslugs, setReslugs] = useState<ReslugCandidate[]>([]);
  const [skippedChosen, setSkippedChosen] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, MergeResult>>({});

  const token = session?.access_token;

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/artist-duplicates', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load duplicates');
      setPairs(data.pairs || []);
      setReslugs(data.reslugCandidates || []);
      setSkippedChosen(data.reslugSkippedChosen || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load duplicates');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function post(body: Record<string, unknown>): Promise<MergeResult | null> {
    if (!token) return null;
    const res = await fetch('/api/admin/artist-duplicates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok && !data.steps) {
      setError(data.error || data.refused || 'Request failed');
      return null;
    }
    return data as MergeResult;
  }

  async function preview(pair: DuplicatePair) {
    setBusy(pair.key);
    setError(null);
    const result = await post({
      action: 'merge', winnerId: pair.winner.id, loserId: pair.loser.id, dryRun: true,
    });
    if (result) setPreviews(prev => ({ ...prev, [pair.key]: result }));
    setBusy(null);
  }

  async function apply(pair: DuplicatePair) {
    setBusy(pair.key);
    setError(null);
    const result = await post({
      action: 'merge', winnerId: pair.winner.id, loserId: pair.loser.id, dryRun: false,
    });
    setBusy(null);
    if (result?.ok) {
      setPreviews(prev => {
        const next = { ...prev };
        delete next[pair.key];
        return next;
      });
      await load();
    } else if (result?.refused) {
      setError(result.refused);
    }
  }

  async function doReslug(candidate: ReslugCandidate) {
    setBusy(candidate.id);
    setError(null);
    await post({ action: 'reslug', artistId: candidate.id, dryRun: false });
    setBusy(null);
    await load();
  }

  const mergeable = pairs.filter(p => p.evidence !== 'name-only' && p.blockers.length === 0);
  const review = pairs.filter(p => p.evidence === 'name-only' || p.blockers.length > 0);

  if (loading) return <p className="text-text-muted text-sm">Loading duplicate artists…</p>;

  return (
    <section className="space-y-4">
      <h2 className="font-display text-lg font-semibold text-text-primary">
        Duplicate artist rows ({pairs.length})
      </h2>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      <p className="text-text-muted text-sm">
        Mergeable pairs have evidence beyond their names. The rest need a look — two artists can share
        a name, so merging on the name alone would put one artist’s links on another’s page.
      </p>

      <h3 className="text-text-secondary text-sm font-semibold">
        Mergeable ({mergeable.length})
      </h3>
      {mergeable.length === 0 ? (
        <p className="text-text-muted text-sm">Nothing to merge.</p>
      ) : (
        mergeable.map(pair => {
          const p = previews[pair.key];
          return (
            <div key={pair.key} className="p-4 rounded-xl bg-surface border border-border space-y-3">
              <span className={`inline-block px-2 py-0.5 rounded border text-xs ${EVIDENCE_STYLE[pair.evidence]}`}>
                {pair.evidence} — {EVIDENCE_LABEL[pair.evidence]}
              </span>
              <div className="space-y-1">
                <RowSummary row={pair.winner} keep />
                <RowSummary row={pair.loser} keep={false} />
              </div>
              {pair.sharedTitles.length > 0 && (
                <p className="text-text-muted text-xs">
                  shared titles: {pair.sharedTitles.slice(0, 5).join(', ')}
                </p>
              )}

              {p && (
                <div className="p-3 rounded-lg bg-bg-secondary text-xs space-y-1">
                  <span className="text-text-muted block">
                    This merge would write, then delete /{pair.loser.slug} and alias it to /{pair.winner.slug}:
                  </span>
                  {p.steps.map((s, i) => (
                    <span key={i} className="block text-text-secondary font-mono">
                      {s.table}: {s.action} ×{s.count}
                    </span>
                  ))}
                  {p.refused && <span className="block text-red-400">{p.refused}</span>}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => void preview(pair)}
                  disabled={busy === pair.key}
                  className="px-3 py-1.5 rounded-lg bg-bg-secondary text-text-primary text-sm hover:bg-border disabled:opacity-50"
                >
                  {busy === pair.key ? 'Working…' : 'Preview'}
                </button>
                {/* Apply only appears after a preview — this deletes an artist row. */}
                {p?.ok && (
                  <button
                    onClick={() => void apply(pair)}
                    disabled={busy === pair.key}
                    className="px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-sm hover:bg-red-500/25 disabled:opacity-50"
                  >
                    Apply merge
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}

      <h3 className="text-text-secondary text-sm font-semibold pt-2">
        Needs a look ({review.length})
      </h3>
      {review.map(pair => (
        <div key={pair.key} className="p-4 rounded-xl bg-surface border border-border space-y-2">
          <span className={`inline-block px-2 py-0.5 rounded border text-xs ${EVIDENCE_STYLE[pair.evidence]}`}>
            {pair.evidence}
          </span>
          <div className="space-y-1">
            <RowSummary row={pair.winner} keep />
            <RowSummary row={pair.loser} keep={false} />
          </div>
          {pair.blockers.map((b, i) => (
            <p key={i} className="text-yellow-400 text-xs">⚠ {b}</p>
          ))}
        </div>
      ))}

      {reslugs.length > 0 && (
        <>
          <h3 className="text-text-secondary text-sm font-semibold pt-2">
            Slugs to fix ({reslugs.length})
          </h3>
          <p className="text-text-muted text-sm">
            These slugs were mangled before accent folding. {skippedChosen} other rows are left alone
            because an artist chose their slug by hand. The old slug keeps working after the change.
          </p>
          {reslugs.map(c => (
            <div key={c.id} className="p-3 rounded-xl bg-surface border border-border flex items-center justify-between gap-3">
              <span className="text-sm">
                <span className="text-text-primary">{c.name}</span>{' '}
                <span className="text-text-muted font-mono text-xs">/{c.from} → /{c.to}</span>
              </span>
              <button
                onClick={() => void doReslug(c)}
                disabled={busy === c.id}
                className="px-3 py-1.5 rounded-lg bg-bg-secondary text-text-primary text-sm hover:bg-border disabled:opacity-50 whitespace-nowrap"
              >
                {busy === c.id ? 'Working…' : 'Fix slug'}
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
