// Release campaigns: the posts Unstream proposes for a release (docs/specs/release-autopost-spec.md,
// "Release campaigns"). The artist edits, moves, drops and adds to them before scheduling.
//
// Pure, like the autopost planner: everything comes in as arguments, so the same release, dates
// and images always propose the same campaign, and tests pin every rule.

import { addDays, daysBetween } from './autopost-plan';
import { CAMPAIGN_STEPS, type CampaignStep } from '../shared/campaign-steps';

export interface ProposalInput {
  /** The release date the artist confirmed, YYYY-MM-DD. */
  releaseDate: string;
  /** The first day the artist wants to post, YYYY-MM-DD. */
  startDate: string;
  /** The artist's local date today. Nothing is proposed before tomorrow. */
  today: string;
  releaseType: string | null;
  /** The release is announced, so a pre-order is open: drafts ask for pre-orders. */
  preorderOpen: boolean;
  onBandcamp: boolean;
  bandcampFridays: string[];
  images: { hasCover: boolean; hasPhoto: boolean; uploadIds: string[] };
}

export interface ProposedPost {
  step: CampaignStep;
  date: string;
  text: string;
  /** 'cover', 'photo' or 'upload:{id}', or null when Unstream holds no image at all. */
  imageKey: string | null;
}

/**
 * Campaign posts are at least this many days apart, so a launch never posts every day; the one
 * exception is the day before release and release day itself.
 */
export const MIN_DAYS_APART = 2;
/** The first Bandcamp Friday after release is part of the campaign if it's this soon. */
const BANDCAMP_FRIDAY_WITHIN_DAYS = 45;
/** Credits only make sense for a record with several people on it. */
const CREDITED_TYPES = new Set(['album', 'ep']);

function adjacentAllowed(a: CampaignStep, b: CampaignStep): boolean {
  const pair = new Set([a, b]);
  return pair.has('tomorrow') && pair.has('release_day');
}

/**
 * The proposed posts, in date order.
 *
 * Every step whose date falls between the start and the end of the timeline is a candidate.
 * The announcement goes on the first day. Candidates are then kept in order of how much they
 * matter to the launch (`priority`), each only if it isn't within MIN_DAYS_APART of one already
 * kept, so a short runway keeps release day, the announcement and the countdown, and drops the
 * story and the credits.
 */
export function proposeCampaign(input: ProposalInput): ProposedPost[] {
  const D = input.releaseDate;
  const earliest = input.startDate > addDays(input.today, 1) ? input.startDate : addDays(input.today, 1);

  const candidates: { step: Exclude<CampaignStep, 'custom'>; date: string }[] = [];
  if (earliest < D) candidates.push({ step: 'announce', date: earliest });
  for (const [step, def] of Object.entries(CAMPAIGN_STEPS) as [Exclude<CampaignStep, 'custom'>, typeof CAMPAIGN_STEPS[keyof typeof CAMPAIGN_STEPS]][]) {
    if (def.offset === null) continue;
    if (step === 'credits' && !CREDITED_TYPES.has(input.releaseType ?? '')) continue;
    const date = addDays(D, def.offset);
    if (date >= earliest) candidates.push({ step, date });
  }
  if (input.onBandcamp) {
    const friday = input.bandcampFridays.find(f => f > D && daysBetween(D, f) <= BANDCAMP_FRIDAY_WITHIN_DAYS);
    if (friday && friday >= earliest) candidates.push({ step: 'bandcamp_friday', date: friday });
  }

  const kept: typeof candidates = [];
  const byPriority = [...candidates].sort((a, b) =>
    CAMPAIGN_STEPS[a.step].priority - CAMPAIGN_STEPS[b.step].priority || (a.date < b.date ? -1 : 1));
  for (const c of byPriority) {
    const clash = kept.some(k => Math.abs(daysBetween(k.date, c.date)) < MIN_DAYS_APART && !adjacentAllowed(k.step, c.step));
    if (!clash) kept.push(c);
  }
  kept.sort((a, b) => (a.date < b.date ? -1 : 1));

  // Personal steps take the artist's uploads in turn, then their photo; the rest show the cover.
  const personal = [...input.images.uploadIds.map(id => `upload:${id}`), ...(input.images.hasPhoto ? ['photo'] : [])];
  const cover = input.images.hasCover ? 'cover' : null;
  let turn = 0;
  const imageFor = (step: Exclude<CampaignStep, 'custom'>): string | null => {
    if (CAMPAIGN_STEPS[step].image === 'cover') return cover ?? personal[0] ?? null;
    if (personal.length === 0) return cover;
    return personal[turn++ % personal.length];
  };

  return kept.map(({ step, date }) => ({
    step,
    date,
    text: CAMPAIGN_STEPS[step].draft[input.preorderOpen && date < D ? 'preorder' : 'out'],
    imageKey: imageFor(step),
  }));
}
