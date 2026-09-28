import { useState } from 'react';
import { GoalProgress } from './GoalProgress';
import { closeGoal, createGoal } from '../services/tips';
import type { TipGoal } from '../types/artist-page';

// Goals on the artist dashboard (spec §3.4): up to three open, closed whenever the artist likes.
// The starting points are music-shaped suggestions, not categories.

const STARTING_POINTS = [
  'Help me press this on vinyl',
  'Help me mix and master the next record',
  'Help me play Boston',
  'Studio days',
  'Van repairs',
];

interface Props {
  token: string;
  slug: string;
  goals: TipGoal[];
  onChange: (goals: TipGoal[]) => void;
}

export function TipGoalsEditor({ token, slug, goals, onChange }: Props) {
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = goals.filter(g => g.status === 'open');

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { goals: next } = await createGoal(token, slug, {
        title: title.trim(),
        targetCents: Math.round(Number(target) * 100),
      });
      onChange(next);
      setTitle(''); setTarget('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that goal');
    } finally {
      setBusy(false);
    }
  };

  const close = async (goalId: string) => {
    setBusy(true);
    try {
      onChange((await closeGoal(token, slug, goalId)).goals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not close that goal');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Goals</p>
      {open.length === 0 && <p className="text-sm text-text-muted">No open goals.</p>}
      {open.map(goal => (
        <div key={goal.id} className="flex items-end gap-3">
          <div className="flex-1"><GoalProgress goal={goal} /></div>
          <button type="button" disabled={busy} onClick={() => close(goal.id)} className="text-xs text-text-muted hover:text-text-primary">
            Close
          </button>
        </div>
      ))}
      {open.length < 3 && (
        <form onSubmit={add} className="space-y-2">
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={80}
            list={`goal-starts-${slug}`}
            placeholder="e.g. Help me press this on vinyl"
            aria-label="Goal title"
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg"
          />
          <datalist id={`goal-starts-${slug}`}>
            {STARTING_POINTS.map(s => <option key={s} value={s} />)}
          </datalist>
          <div className="flex flex-wrap gap-2">
            <input
              value={target}
              onChange={e => setTarget(e.target.value)}
              type="number"
              min={1}
              step="1"
              placeholder="Target ($)"
              aria-label="Target in dollars"
              className="w-32 px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg"
            />
            <button type="submit" disabled={busy || !title.trim() || !target} className="px-3 py-2 text-sm rounded-lg bg-accent-primary text-white disabled:opacity-50">
              Add goal
            </button>
          </div>
          <p className="text-xs text-text-muted">Tips are unconditional: fans are told their tip reaches you whether or not the goal is met.</p>
        </form>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
