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

/**
 * A release date as it reads in an American post: "September 3, 2026", "September 2026" or
 * "2026", only as precisely as the source gave it. Not `formatReleaseDate`, which is the release
 * page's British "3 September 2026".
 */
export function postDate(date: string | null, precision: string | null): string | null {
  if (!date || precision === 'unknown') return null;
  const [year, month, day] = date.split('-').map(Number);
  if (!Number.isFinite(year)) return null;
  if (precision === 'year') return String(year);
  const monthName = new Date(Date.UTC(year, (month || 1) - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  if (precision === 'month') return `${monthName} ${year}`;
  return `${monthName} ${day}, ${year}`;
}

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
    date: postDate(release.releaseDate, precision),
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
 * Unstream's defaults. **In the artist's own voice, first person** (Brandon, 2026-10-29): the
 * posts go out from their account, so "reaches me", not "reaches {name}". In American English,
 * avoiding words spelled differently by region ("archives", not "catalogue").
 *
 * Every kind's **last** variant needs nothing but {title}, {link} and {where}, so a release with
 * no date, type or price can still be posted about. Never put an article before {type}: "a EP"
 * and "a album" are both wrong.
 */
export const DEFAULT_TEMPLATES: Record<AutopostKind, string[]> = {
  bandcamp_friday: [
    'It’s Bandcamp Friday: Bandcamp waives its revenue share today, so more of what you pay comes to me. {title}[ ({type})] is there: {link}',
    'Bandcamp Friday today. If you’ve been meaning to pick up {title}, today more of it comes to me: {link}',
  ],
  release_day: [
    '{title}[, my new {type},] is out today! [{note} ]Find it on {where}: {link}',
    'My new release {title} is out today on {where}. {link}',
  ],
  preorder: [
    '{title}[, my new {type},] comes out {date}. [{note} ]Pre-order it on {where}: {link}',
    'Coming soon: {title}. You can pre-order it now on {where}: {link}',
  ],
  out_now: [
    '{title}[, my new {type},] is out now. [{note} ]Find it on {where}: {link}',
    'New from me: {title}, out now on {where}. {link}',
  ],
  still_new: [
    '{title} came out {date}. [{note} ]If you haven’t heard it yet, it’s on {where}: {link}',
    'In case you missed it: my new release {title} is on {where}. {link}',
  ],
  catalogue: [
    'From the archives: {title}[ ({year})]. [{note} ]It’s on {where}: {link}',
    '{title}[ came out {age}]. [{note} ]Listen and buy it on {where}: {link}',
    'From the archives: {title}, on {where}. {link}',
  ],
  support: [
    'If you want to support me directly, here’s how, and how much reaches me each way: {link}',
    'The best ways to support my music: {link}',
  ],
};
