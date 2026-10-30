// Where each release autopost post stands, for the Promote page's "Coming up" and "Recent".
//
// Three sources meet here: the plan (posts not handed to Buffer yet, recomputed every time), the
// stored slots (posts the sweep claimed: sending, in Buffer, or failed), and Buffer itself (whether
// a post in Buffer is still scheduled, has gone out, or failed there). Pure, so the rules for
// which one wins are pinned by tests: a stored slot always outranks the plan, except a failed one
// the sweep will try again, which shows as the plan's post with why the last try failed.

import type { AutopostKind, PlannedPost } from './autopost-plan';
import type { BufferPostState } from './buffer-client';
import type { StoredSlot } from './release-autopost-db';

/** One channel's copy of a post handed to Buffer. */
export interface ChannelState {
  channelId: string;
  service: string;
  /**
   * Buffer's own status (scheduled, sending, sent, error, draft, needs_approval), 'missing' when
   * Buffer no longer has it (deleted there, or its tag removed), or 'unknown' when Buffer couldn't
   * be asked just now.
   */
  status: string;
  dueAt: string | null;
  /** The published post, once Buffer has sent it. */
  link: string | null;
  error: string | null;
}

export type PostState =
  /** Not in Buffer yet: the sweep hands it over from `toBufferAt`. */
  | { is: 'planned'; toBufferAt: string; lastError: string | null }
  | { is: 'sending' }
  /** Never reached Buffer, and won't be tried again. */
  | { is: 'failed'; error: string | null }
  /** `skipped` says which channels it didn't go to, and why. */
  | { is: 'in_buffer'; channels: ChannelState[]; skipped: string | null };

export interface LivePosts {
  posts: Map<string, BufferPostState>;
  complete: boolean;
}

export interface ViewSlot {
  at: string;
  date: string;
  kind: AutopostKind;
  releaseId: string | null;
  templateIndex: number;
  imageKey: string | null;
  imageOnInstagram: boolean;
  /** What each channel was actually sent, for a post already in Buffer. */
  captions: StoredSlot['captions'] | null;
  state: PostState;
}

/** Past posts shown under "Recent", newest first. */
export const RECENT_LIMIT = 10;

export function buildScheduleView(input: {
  plan: PlannedPost[];
  stored: StoredSlot[];
  /**
   * Buffer's posts by id, and whether that's all of them (so a post not there is gone), or null
   * when Buffer couldn't be asked.
   */
  live: LivePosts | null;
  /** The artist's local date today: earlier posts are "Recent", the rest "Coming up". */
  today: string;
  pushAheadHours: number;
  maxAttempts: number;
}): { upcoming: ViewSlot[]; recent: ViewSlot[] } {
  const planned = new Map(input.plan.map(p => [p.at, p]));
  const slots: ViewSlot[] = [];

  for (const row of input.stored) {
    const replan = planned.get(row.slotAt);
    planned.delete(row.slotAt);
    // The sweep retries a failed slot while it's still planned and has tries left.
    if (row.status === 'failed' && replan && row.attempts < input.maxAttempts) {
      slots.push(fromPlan(replan, input.pushAheadHours, row.error));
      continue;
    }
    slots.push({
      at: row.slotAt,
      date: row.slotDate,
      kind: row.kind,
      releaseId: row.releaseId,
      templateIndex: row.templateIndex,
      imageKey: row.imageKey,
      imageOnInstagram: row.imageOnInstagram,
      captions: row.status === 'pushed' ? row.captions : null,
      state: storedState(row, input.live),
    });
  }
  for (const p of planned.values()) slots.push(fromPlan(p, input.pushAheadHours, null));

  slots.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    upcoming: slots.filter(s => s.date >= input.today),
    recent: slots.filter(s => s.date < input.today).reverse().slice(0, RECENT_LIMIT),
  };
}

function fromPlan(p: PlannedPost, pushAheadHours: number, lastError: string | null): ViewSlot {
  return {
    at: p.at,
    date: p.date,
    kind: p.kind,
    releaseId: p.releaseId,
    templateIndex: p.templateIndex,
    imageKey: p.imageKey,
    imageOnInstagram: p.imageOnInstagram,
    captions: null,
    state: {
      is: 'planned',
      toBufferAt: new Date(new Date(p.at).getTime() - pushAheadHours * 3_600_000).toISOString(),
      lastError,
    },
  };
}

function storedState(row: StoredSlot, live: LivePosts | null): PostState {
  if (row.status === 'pushing') return { is: 'sending' };
  if (row.status === 'failed') return { is: 'failed', error: row.error };
  return {
    is: 'in_buffer',
    skipped: row.error,
    channels: row.bufferPostIds.map(({ channelId, postId }) => {
      const service = row.captions[channelId]?.service ?? '';
      if (!live) return { channelId, service, status: 'unknown', dueAt: null, link: null, error: null };
      const post = live.posts.get(postId);
      // Gone only if Buffer listed everything; otherwise it may simply not have been reached.
      if (!post) return { channelId, service, status: live.complete ? 'missing' : 'unknown', dueAt: null, link: null, error: null };
      return { channelId, service, status: post.status, dueAt: post.dueAt, link: post.externalLink, error: post.error };
    }),
  };
}
