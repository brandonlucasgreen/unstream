// Release campaigns: the posts Unstream proposes for a release (docs/specs/release-autopost-spec.md,
// "Release campaigns"). The artist edits, moves, drops and adds to them before scheduling.
//
// Pure, like the autopost planner: everything comes in as arguments, so the same release, dates
// and images always propose the same campaign, and tests pin every rule.

import { addDays, daysBetween } from './autopost-plan';
import {
  AFTER_RELEASE_STEPS,
  CAMPAIGN_STEPS,
  DEFAULT_RUN_WEEKS,
  OLDER_AFTER_DAYS,
  RUN_WEEKS,
  type CampaignStep,
} from '../shared/campaign-steps';

export interface ProposalInput {
  /** The release date the artist confirmed, YYYY-MM-DD. */
  releaseDate: string;
  /** Before release: the first day the artist wants to post, YYYY-MM-DD. Ignored once it's out. */
  startDate: string;
  /** Once it's out: how many weeks the campaign runs, from tomorrow (RUN_WEEKS). */
  runWeeks?: number;
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

type Step = Exclude<CampaignStep, 'custom'>;
type Candidate = { step: Step; date: string };

function adjacentAllowed(a: CampaignStep, b: CampaignStep): boolean {
  const pair = new Set([a, b]);
  return pair.has('tomorrow') && pair.has('release_day');
}

/** Whether a release is out by tomorrow, the first day a campaign can post: then it gets the after-release set. */
export function isAlreadyOut(releaseDate: string, today: string): boolean {
  return releaseDate <= today;
}

/**
 * The proposed posts, in date order. A release still to come gets the full timeline around
 * release day (`beforeRelease`); one already out gets a shorter run from tomorrow (`afterRelease`).
 * Either way, candidates are kept in order of how much they matter (`priority`), each only if it
 * isn't within MIN_DAYS_APART of one already kept.
 */
export function proposeCampaign(input: ProposalInput): ProposedPost[] {
  const candidates = isAlreadyOut(input.releaseDate, input.today) ? afterRelease(input) : beforeRelease(input);

  const kept: Candidate[] = [];
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
  const imageFor = (step: Step): string | null => {
    if (CAMPAIGN_STEPS[step].image === 'cover') return cover ?? personal[0] ?? null;
    if (personal.length === 0) return cover;
    return personal[turn++ % personal.length];
  };

  return kept.map(({ step, date }) => ({ step, date, text: draftFor(step, date, input), imageKey: imageFor(step) }));
}

/** Pre-order wording only before release day while one is open; "no longer new" wording once it isn't. */
function draftFor(step: Step, date: string, input: ProposalInput): string {
  const draft = CAMPAIGN_STEPS[step].draft;
  if (input.preorderOpen && date < input.releaseDate) return draft.preorder;
  if (draft.older && daysBetween(input.releaseDate, date) >= OLDER_AFTER_DAYS) return draft.older;
  return draft.out;
}

function earliestDay(input: ProposalInput): string {
  const tomorrow = addDays(input.today, 1);
  return input.startDate > tomorrow ? input.startDate : tomorrow;
}

function bandcampFridayBetween(input: ProposalInput, from: string, to: string): string | undefined {
  if (!input.onBandcamp) return undefined;
  return input.bandcampFridays.find(f => f >= from && f <= to);
}

/** Every step whose date falls between the start and the end of the timeline; the announcement goes on the first day. */
function beforeRelease(input: ProposalInput): Candidate[] {
  const D = input.releaseDate;
  const earliest = earliestDay(input);
  const candidates: Candidate[] = [];
  if (earliest < D) candidates.push({ step: 'announce', date: earliest });
  for (const [step, def] of Object.entries(CAMPAIGN_STEPS) as [Step, typeof CAMPAIGN_STEPS[Step]][]) {
    if (def.offset === null) continue;
    if (step === 'credits' && !CREDITED_TYPES.has(input.releaseType ?? '')) continue;
    const date = addDays(D, def.offset);
    if (date >= earliest) candidates.push({ step, date });
  }
  // The first after release; release day itself being one is release day's post.
  const friday = bandcampFridayBetween(input, addDays(D, 1), addDays(D, BANDCAMP_FRIDAY_WITHIN_DAYS));
  if (friday && friday >= earliest) candidates.push({ step: 'bandcamp_friday', date: friday });
  return candidates;
}

/**
 * Already out: "It's out" tomorrow, then the story, the credits, a thank-you and "in case you
 * missed it", spread evenly over the weeks chosen, plus a Bandcamp Friday that falls inside them.
 */
function afterRelease(input: ProposalInput): Candidate[] {
  const weeks = RUN_WEEKS.includes(input.runWeeks as typeof RUN_WEEKS[number]) ? input.runWeeks! : DEFAULT_RUN_WEEKS;
  const start = addDays(input.today, 1);
  const span = weeks * 7 - 1;
  const steps = AFTER_RELEASE_STEPS.filter(step => step !== 'credits' || CREDITED_TYPES.has(input.releaseType ?? ''));
  const candidates: Candidate[] = steps.map((step, i) => ({
    step,
    date: addDays(start, Math.round((i * span) / (steps.length - 1))),
  }));
  const friday = bandcampFridayBetween(input, start, addDays(start, span));
  if (friday) candidates.push({ step: 'bandcamp_friday', date: friday });
  return candidates;
}
