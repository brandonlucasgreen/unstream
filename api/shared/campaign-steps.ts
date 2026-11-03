// Release campaigns: the steps a campaign is made of (docs/specs/release-autopost-spec.md,
// "Release campaigns"). Shared by the server, which proposes and posts them, and the Promote
// page, which labels them.
//
// **No LLM writes these either.** Each step's draft is a template in the autopost template
// language, in the artist's own voice, filled with facts Unstream holds. The artist edits them
// before scheduling; what's stored and posted is their text.
//
// The shape of the timeline comes from published release-promotion advice (CD Baby's six-week
// and 30-day plans, Sonicbids' four-week plan) and Buffer's posting-frequency studies, as
// summarised in the spec: announce with the date and where to buy, a story in the middle, a
// countdown of a week and a day, release day, then a thank-you, an "in case you missed it" and
// the first Bandcamp Friday after.

export type CampaignStep =
  | 'announce'
  | 'story'
  | 'credits'
  | 'week_to_go'
  | 'tomorrow'
  | 'release_day'
  | 'thank_you'
  | 'icymi'
  | 'bandcamp_friday'
  | 'custom';

/** Which image a step starts with: the release's cover, or something personal (an upload or the artist's photo). */
export type StepImage = 'cover' | 'personal';

export interface StepDefinition {
  label: string;
  /** Days from release day. null for steps placed by other rules (announce, Bandcamp Friday, custom). */
  offset: number | null;
  /**
   * Lower goes first when two steps would land too close together: the one kept is the one that
   * matters more to the launch.
   */
  priority: number;
  image: StepImage;
  /** The draft while pre-orders are open (the release is announced), and once it's out. */
  draft: { preorder: string; out: string };
}

/**
 * Drafts never put an article before {type} ("a EP"), and bracket anything that might be
 * missing, so every step can be filled for a release with no type, price or note.
 */
export const CAMPAIGN_STEPS: Record<Exclude<CampaignStep, 'custom'>, StepDefinition> = {
  announce: {
    label: 'Announcement',
    offset: null,
    priority: 2,
    image: 'cover',
    draft: {
      preorder: '{title}[, my new {type},] comes out {date}. [{note} ]You can pre-order it now on {where}: {link}',
      out: '{title}[, my new {type},] comes out {date}. [{note} ]It’ll be on {where}: {link}',
    },
  },
  story: {
    label: 'The story behind it',
    offset: -21,
    priority: 6,
    image: 'personal',
    draft: {
      preorder: 'A little about {title} before it’s out {date}. [{note} ]Pre-order: {link}',
      out: 'A little about {title} before it’s out {date}. [{note} ]{link}',
    },
  },
  credits: {
    label: 'Thanking the people on it',
    offset: -14,
    priority: 7,
    image: 'personal',
    draft: {
      preorder: '{title} wouldn’t exist without everyone who helped make it. Thank you. It’s out {date}, and up for pre-order on {where}: {link}',
      out: '{title} wouldn’t exist without everyone who helped make it. Thank you. It’s out {date} on {where}: {link}',
    },
  },
  week_to_go: {
    label: 'One week to go',
    offset: -7,
    priority: 3,
    image: 'cover',
    draft: {
      preorder: 'One week until {title} is out. Pre-order it on {where}: {link}',
      out: 'One week until {title} is out on {where}. {link}',
    },
  },
  tomorrow: {
    label: 'Tomorrow',
    offset: -1,
    priority: 4,
    image: 'personal',
    draft: {
      preorder: '{title} is out tomorrow. {link}',
      out: '{title} is out tomorrow. {link}',
    },
  },
  release_day: {
    label: 'Release day',
    offset: 0,
    priority: 1,
    image: 'cover',
    draft: {
      preorder: '{title}[, my new {type},] is out today! [{note} ]Find it on {where}: {link}',
      out: '{title}[, my new {type},] is out today! [{note} ]Find it on {where}: {link}',
    },
  },
  thank_you: {
    label: 'Thank you',
    offset: 3,
    priority: 5,
    image: 'personal',
    draft: {
      preorder: 'Thank you to everyone who’s picked up {title} so far. It means a lot. {link}',
      out: 'Thank you to everyone who’s picked up {title} so far. It means a lot. {link}',
    },
  },
  icymi: {
    label: 'In case you missed it',
    offset: 10,
    priority: 6,
    image: 'cover',
    draft: {
      preorder: 'In case you missed it: {title} is out now on {where}. {link}',
      out: 'In case you missed it: {title} is out now on {where}. {link}',
    },
  },
  bandcamp_friday: {
    label: 'Bandcamp Friday',
    offset: null,
    priority: 3,
    image: 'cover',
    draft: {
      preorder: 'It’s Bandcamp Friday: Bandcamp waives its revenue share today, so more of what you pay comes to me. {title} is there: {link}',
      out: 'It’s Bandcamp Friday: Bandcamp waives its revenue share today, so more of what you pay comes to me. {title} is there: {link}',
    },
  },
};

export function stepLabel(step: string): string {
  return step in CAMPAIGN_STEPS ? CAMPAIGN_STEPS[step as Exclude<CampaignStep, 'custom'>].label : 'Your own post';
}

export function isCampaignStep(step: string): step is CampaignStep {
  return step === 'custom' || step in CAMPAIGN_STEPS;
}

/** How far ahead of release day a campaign can start, in weeks: the choices on the Promote page. */
export const RUNWAY_WEEKS = [1, 2, 4, 6, 8] as const;
/** About four weeks is the practical minimum for a full campaign in the advice the spec draws on. */
export const DEFAULT_RUNWAY_WEEKS = 4;
