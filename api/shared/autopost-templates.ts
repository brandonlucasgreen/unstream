// Release autopost: the words (docs/specs/release-autopost-spec.md, "The words").
//
// **No LLM writes these posts.** A post is a template an artist can read and edit, filled with
// facts Unstream holds. Same template, same facts, same post, every time.
//
// The template language is deliberately small:
//
//   {variable}            a fact, e.g. {title}, {where}, {link}
//   [optional segment]    dropped whole when any variable inside it has no value, so
//                         "{title}[, from {year}]" prints no stray ", from " for an undated release
//
// A variable outside brackets with no value makes the template unusable for that release
// (renderTemplate returns null), so the caller tries the next variant rather than posting a hole.
//
// Shared by the server (which posts) and the web app (which previews as the artist types).

import { PLATFORMS } from './platform-registry';
import {
  formatReleaseDate,
  leadingOfferSummary,
  orderedSourcePlatforms,
  type ReleaseSourceSummary,
} from './release-display';

const SITE = 'https://unstream.stream';

export type AutopostKind =
  | 'bandcamp_friday'
  | 'release_day'
  | 'preorder'
  | 'out_now'
  | 'still_new'
  | 'catalogue'
  | 'support';

export const AUTOPOST_KINDS: readonly AutopostKind[] = [
  'bandcamp_friday', 'release_day', 'preorder', 'out_now', 'still_new', 'catalogue', 'support',
];

export const TEMPLATE_VARIABLES = [
  'name', 'title', 'type', 'date', 'year', 'age', 'where', 'price', 'link', 'note',
] as const;

export type TemplateVariable = typeof TEMPLATE_VARIABLES[number];
export type TemplateVars = Partial<Record<TemplateVariable, string | null>>;

const KNOWN = new Set<string>(TEMPLATE_VARIABLES);

// ---------------------------------------------------------------------------------------------
// Parsing and rendering
// ---------------------------------------------------------------------------------------------

type Piece =
  | { text: string }
  | { variable: string }
  | { optional: ({ text: string } | { variable: string })[] };

/** Split a template into pieces, or list what's wrong with it. */
function parse(template: string): { pieces: Piece[]; problems: string[] } {
  const pieces: Piece[] = [];
  const problems: string[] = [];
  let segment: ({ text: string } | { variable: string })[] | null = null;
  let text = '';

  const flushText = () => {
    if (!text) return;
    (segment ?? pieces).push({ text });
    text = '';
  };

  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '{') {
      const end = template.indexOf('}', i);
      if (end === -1) { problems.push('A "{" is never closed'); break; }
      const name = template.slice(i + 1, end).trim();
      if (!KNOWN.has(name)) problems.push(`Unknown variable {${name}}`);
      flushText();
      (segment ?? pieces).push({ variable: name });
      i = end;
    } else if (ch === '}') {
      problems.push('A "}" has no matching "{"');
    } else if (ch === '[') {
      if (segment) { problems.push('Optional segments can’t be nested'); continue; }
      flushText();
      segment = [];
    } else if (ch === ']') {
      if (!segment) { problems.push('A "]" has no matching "["'); continue; }
      flushText();
      pieces.push({ optional: segment });
      segment = null;
    } else {
      text += ch;
    }
  }
  if (segment) problems.push('A "[" is never closed');
  flushText();
  return { pieces, problems };
}

/** What's wrong with a template, in words for the artist. Empty when it's fine. */
export function templateProblems(template: string): string[] {
  const { problems } = parse(template);
  if (!template.trim()) problems.push('The template is empty');
  return [...new Set(problems)];
}

/**
 * Fill a template, or null when it can't be filled for these facts: a required variable has no
 * value, or the template itself is broken.
 */
export function renderTemplate(template: string, vars: TemplateVars): string | null {
  const { pieces, problems } = parse(template);
  if (problems.length) return null;

  const valueOf = (name: string): string | null => {
    const value = vars[name as TemplateVariable];
    return value && value.trim() ? value.trim() : null;
  };

  let out = '';
  for (const piece of pieces) {
    if ('text' in piece) {
      out += piece.text;
    } else if ('variable' in piece) {
      const value = valueOf(piece.variable);
      if (value === null) return null;
      out += value;
    } else {
      let part = '';
      let complete = true;
      for (const inner of piece.optional) {
        if ('text' in inner) { part += inner.text; continue; }
        const value = valueOf(inner.variable);
        if (value === null) { complete = false; break; }
        part += value;
      }
      if (complete) out += part;
    }
  }

  // Dropped segments leave doubled spaces behind; tidy those, but keep the artist's line breaks.
  const tidy = out
    .split('\n')
    .map(line => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return tidy || null;
}

/**
 * The post for a slot: the planned variant if it can be filled, otherwise the next one that
 * can, in turn. null when none can, and then the post doesn't go out.
 */
export function renderVariant(variants: string[], startIndex: number, vars: TemplateVars): { text: string; index: number } | null {
  for (let step = 0; step < variants.length; step++) {
    const index = (startIndex + step) % variants.length;
    const text = renderTemplate(variants[index], vars);
    if (text !== null) return { text, index };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------------------------

export interface TemplateArtist {
  name: string;
  slug: string;
}

export interface TemplateRelease {
  title: string;
  slug: string;
  releaseType: string | null;
  releaseDate: string | null;
  datePrecision: string | null;
  /** The artist's own line about this release (`releases.note`). */
  note?: string | null;
  sources: ReleaseSourceSummary[];
}

export interface FactOptions {
  /** The local date the post goes out on, YYYY-MM-DD. Facts like {age} are true on that day. */
  postDate: string;
  /** Instagram has no clickable links in posts. */
  instagram: boolean;
}

/** Lower-case, as it reads mid-sentence. 'other' is "we don't know", so it has no word. */
const TYPE_WORDS: Record<string, string> = {
  album: 'album',
  ep: 'EP',
  single: 'single',
  compilation: 'compilation',
  live: 'live album',
  remix: 'remix',
};

const SMALL_NUMBERS = ['', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** "a year ago", "five years ago", "12 years ago"; null under a year or without a date. */
export function ageInWords(releaseDate: string | null, datePrecision: string | null, postDate: string): string | null {
  if (!releaseDate || datePrecision === 'unknown') return null;
  const [ry, rm, rd] = releaseDate.split('-').map(Number);
  const [py, pm, pd] = postDate.split('-').map(Number);
  let years = py - ry;
  // Only a day-precise date can say the anniversary hasn't come yet this year.
  if (datePrecision === 'day' && (pm < rm || (pm === rm && pd < rd))) years -= 1;
  if (datePrecision === 'month' && pm < rm) years -= 1;
  if (!Number.isFinite(years) || years < 1) return null;
  const count = years < SMALL_NUMBERS.length ? SMALL_NUMBERS[years] : String(years);
  return `${count} year${years === 1 ? '' : 's'} ago`;
}

/** "Bandcamp", "Bandcamp and Mirlo", "Mirlo, Bandcamp and Faircamp": artist-paying first, three at most. */
export function whereToBuy(sources: ReleaseSourceSummary[]): string | null {
  // Discogs is mostly secondhand copies, which pay the artist nothing, so it's never named as
  // a place to buy their music.
  const names = orderedSourcePlatforms(sources.filter(s => s.platform !== 'discogs'))
    .map(p => PLATFORMS[p]?.name)
    .filter((n): n is string => Boolean(n))
    .slice(0, 3);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function releasePageUrl(artist: TemplateArtist, release: { slug: string }): string {
  return `${SITE}/a/${artist.slug}/${release.slug}`;
}

/** Every fact a release post can use. Links always go to Unstream's release page. */
export function releaseTemplateVars(release: TemplateRelease, artist: TemplateArtist, options: FactOptions): TemplateVars {
  const precision = release.datePrecision;
  return {
    name: artist.name,
    title: release.title,
    type: release.releaseType ? TYPE_WORDS[release.releaseType] ?? null : null,
    date: formatReleaseDate(release.releaseDate, precision) || null,
    year: release.releaseDate && precision !== 'unknown' ? release.releaseDate.slice(0, 4) : null,
    age: ageInWords(release.releaseDate, precision, options.postDate),
    where: whereToBuy(release.sources),
    price: leadingOfferSummary(release.sources) || null,
    link: options.instagram ? 'link in bio' : releasePageUrl(artist, release),
    note: release.note?.trim() || null,
  };
}

/** The facts for a call for support: the Tip page if they take tips, otherwise their artist page. */
export function supportTemplateVars(artist: TemplateArtist, options: { takesTips: boolean; instagram: boolean }): TemplateVars {
  const link = options.takesTips ? `${SITE}/tip/${artist.slug}` : `${SITE}/a/${artist.slug}`;
  return { name: artist.name, link: options.instagram ? 'link in bio' : link };
}

// ---------------------------------------------------------------------------------------------
// What artists start from
// ---------------------------------------------------------------------------------------------

/**
 * Unstream's defaults: plain notices, not the artist pretending to talk. The spec's option 1;
 * Brandon tests these against writing his own before artists see either (Build plan step 2).
 *
 * Every kind's **last** variant needs nothing but {name}, {title}, {link} and {where}, so a
 * release with no date, type or price can still be posted about. Never put an article before
 * {type}: "a EP" and "a album" are both wrong.
 */
export const DEFAULT_TEMPLATES: Record<AutopostKind, string[]> = {
  bandcamp_friday: [
    'It’s Bandcamp Friday: Bandcamp waives its revenue share today, so more of what you pay reaches {name}. {title}[ ({type})] is there: {link}',
    'Bandcamp Friday today. Buy {title} on Bandcamp and more of it goes to {name}: {link}',
  ],
  release_day: [
    'Out today: {title}[ ({type})]. [{note} ]On {where}: {link}',
    '{title} is out today on {where}. {link}',
  ],
  preorder: [
    '{title}[ ({type})] comes out {date}. [{note} ]Pre-order on {where}: {link}',
    'Coming soon: {title}. Pre-order on {where}: {link}',
  ],
  out_now: [
    'New: {title}[ ({type})] is out now. [{note} ]On {where}: {link}',
    '{title} is out now on {where}. {link}',
  ],
  still_new: [
    '{title} came out {date}. [{note} ]It’s on {where}: {link}',
    'In case you missed it: {title}, on {where}. {link}',
  ],
  catalogue: [
    'From the catalogue: {title}[ ({year})]. [{note} ]On {where}: {link}',
    '{title}[, released {age}]. [{note} ]Listen and buy on {where}: {link}',
    '{title}, on {where}. {link}',
  ],
  support: [
    'Want to support {name} directly? Here’s how, and what reaches them: {link}',
    'The best ways to support {name}: {link}',
  ],
};
