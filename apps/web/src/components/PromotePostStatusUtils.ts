import type { PromotePostState } from '../services/promote';

/** Whether a post needs the artist to look: something failed, or is stuck in Buffer. */
export function needsAttention(state: PromotePostState): boolean {
  if (state.is === 'failed') return true;
  if (state.is === 'planned') return state.lastError !== null;
  if (state.is === 'in_buffer') return state.channels.some(c => c.status === 'error' || c.status === 'draft' || c.status === 'needs_approval');
  return false;
}
