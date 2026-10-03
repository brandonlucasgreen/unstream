import { formatUsd } from '../../../../api/shared/tips';
import type { TipGoal } from '../types/artist-page';

// An artist goal as a progress bar (spec §3.4). The bar can pass 100%: goals are trackers, and a
// fan can keep tipping after the target.

export function GoalProgress({ goal }: { goal: TipGoal }) {
  const percent = goal.targetCents > 0 ? Math.round((goal.raisedCents / goal.targetCents) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between gap-3 text-sm">
        <span className="font-medium text-text-primary">{goal.title}</span>
        <span className="text-text-muted tabular-nums whitespace-nowrap">
          {formatUsd(goal.raisedCents)} of {formatUsd(goal.targetCents)}
        </span>
      </div>
      <div
        className="mt-1.5 h-2 rounded-full bg-bg-hover overflow-hidden"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${goal.title}: ${percent}%`}
      >
        <div className="h-full bg-accent-primary" style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      {percent > 100 && <p className="mt-1 text-xs text-text-muted">{percent}% — past the goal</p>}
    </div>
  );
}
