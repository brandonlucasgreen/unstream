/**
 * Pure logic for the weekly industry digest: feed parsing, candidate selection, the prompt, and
 * validating and rendering what the model sends back. No network, no filesystem — run.ts does
 * the I/O, and this file is tested in apps/web/tests/unit/industry-digest.test.ts.
 *
 * The one rule that shapes everything here: **the model never writes a URL.** Every candidate
 * story gets a numeric id, the model cites ids, and the links in the published digest are
 * rendered from the candidates we fetched. A cited id we never handed out is dropped, so a
 * hallucinated story can't arrive with a convincing link attached.
 */

import { XMLParser } from 'fast-xml-parser';

export interface Candidate {
  /** Short numeric id the model cites. Assigned by numberCandidates. */
  id: number;
  title: string;
  url: string;
  /** Feed name, or the hostname for a web-search result. */
  source: string;
  /** ISO timestamp, or null for web-search results (the search API returns no dates). */
  publishedAt: string | null;
  /** Plain-text excerpt, already trimmed to EXCERPT_CHARS. */
  excerpt: string;
  origin: 'feed' | 'search';
}

export type RawCandidate = Omit<Candidate, 'id'>;

export interface DigestStory {
  headline: string;
  body: string;
  sourceIds: number[];
}

export interface DigestSection {
  heading: string;
  stories: DigestStory[];
}

export interface Digest {
  title: string;
  summary: string;
  intro: string;
  sections: DigestSection[];
  /** Product ideas or questions for Unstream prompted by the week's news. */
  forUnstream: string[];
}

export const EXCERPT_CHARS = 500;

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Feeds put HTML in CDATA; keep it as text and strip it ourselves.
  cdataPropName: false,
  processEntities: true,
  htmlEntities: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A text node may arrive as a string, a number, or `{ '#text': ... }` when it has attributes. */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text']);
  }
  return '';
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

/** HTML to plain text: drop tags, decode the entities feeds actually use, collapse whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function toIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Parse an RSS 2.0 or Atom document into candidates. Items without a title or an http(s) link
 * are dropped. Throws on a document that is neither format, so a feed that has started serving
 * an HTML error page is reported rather than read as "no news this week".
 */
export function parseFeed(xml: string, sourceName: string): RawCandidate[] {
  const doc = xmlParser.parse(xml);

  if (doc?.rss?.channel) {
    return asArray(doc.rss.channel.item).flatMap((item: Record<string, unknown>) => {
      const url = text(item.link).trim();
      const title = htmlToText(text(item.title));
      if (!title || !/^https?:\/\//.test(url)) return [];
      const body = text(item.description) || text(item['content:encoded']);
      return [{
        title,
        url,
        source: sourceName,
        publishedAt: toIso(text(item.pubDate) || text(item['dc:date'])),
        excerpt: truncate(htmlToText(body), EXCERPT_CHARS),
        origin: 'feed' as const,
      }];
    });
  }

  if (doc?.feed) {
    return asArray(doc.feed.entry).flatMap((entry: Record<string, unknown>) => {
      const links = asArray(entry.link as Record<string, string> | Record<string, string>[]);
      const link = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
      const url = (link?.['@_href'] ?? '').trim();
      const title = htmlToText(text(entry.title));
      if (!title || !/^https?:\/\//.test(url)) return [];
      return [{
        title,
        url,
        source: sourceName,
        publishedAt: toIso(text(entry.published) || text(entry.updated)),
        excerpt: truncate(htmlToText(text(entry.summary) || text(entry.content)), EXCERPT_CHARS),
        origin: 'feed' as const,
      }];
    });
  }

  throw new Error('not an RSS or Atom document');
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for de-duplication: the same story reaches us from a feed and from search,
 * with and without tracking parameters and trailing slashes.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith('utm_') || key === 'ref' || key === 'source') parsed.searchParams.delete(key);
    }
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');
    const query = parsed.searchParams.toString();
    return `${parsed.hostname.replace(/^www\./, '')}${path}${query ? `?${query}` : ''}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Keep feed items published inside the window and every search result (undated — the prompt
 * tells the model to judge those on their content). Drops anything an earlier digest already
 * cited, then de-duplicates by URL, preferring the feed copy because it carries a date.
 * Newest first, capped per source so one prolific feed can't crowd out the rest, then overall.
 */
export function selectCandidates(
  raw: RawCandidate[],
  options: { since: Date; previouslyCited: Set<string>; perSourceCap: number; totalCap: number },
): RawCandidate[] {
  const sinceMs = options.since.getTime();
  const inWindow = raw.filter((c) => {
    if (options.previouslyCited.has(normalizeUrl(c.url))) return false;
    if (c.origin === 'search') return true;
    return c.publishedAt !== null && new Date(c.publishedAt).getTime() >= sinceMs;
  });

  const ordered = [...inWindow].sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === 'feed' ? -1 : 1;
    return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
  });

  const seen = new Set<string>();
  const perSource = new Map<string, number>();
  const selected: RawCandidate[] = [];
  for (const candidate of ordered) {
    const key = normalizeUrl(candidate.url);
    if (seen.has(key)) continue;
    const count = perSource.get(candidate.source) ?? 0;
    if (count >= options.perSourceCap) continue;
    seen.add(key);
    perSource.set(candidate.source, count + 1);
    selected.push(candidate);
    if (selected.length >= options.totalCap) break;
  }
  return selected;
}

export function numberCandidates(raw: RawCandidate[]): Candidate[] {
  return raw.map((c, i) => ({ ...c, id: i + 1 }));
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface PromptContext {
  /** e.g. "Bandcamp (marketplace, 80-85% to artists)" — from platform-registry.ts. */
  platforms: string[];
  weekLabel: string;
  windowStart: string;
  windowEnd: string;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  return `You write a private weekly briefing for the founder of Unstream (unstream.stream).

About Unstream: a music search app that helps listeners find artists on platforms outside streaming, so they can support artists directly. It shows verified links grouped by category with each platform's artist payout percentage. Mission: deepen the connection between fans and artists so appreciation turns into lasting support. Artists first, supporters second.

Platforms Unstream covers:
${ctx.platforms.map((p) => `- ${p}`).join('\n')}

What matters to the reader, roughly in order:
1. News about the platforms above, or new direct-to-fan / artist-owned platforms.
2. Streaming economics: payouts, royalty rules, pricing, catalogue thresholds, label deals that change what artists earn.
3. AI and music: generated tracks on streaming services, platform AI policies, training and licensing disputes.
4. How fans discover and pay for music: Bandcamp Friday, merch, subscriptions, patronage, vinyl, live.
5. Policy and law affecting independent artists.
Ignore celebrity news, chart positions, tour announcements, gear reviews and anything that only matters to major labels' shareholders.

Rules:
- Use ONLY the numbered stories you are given. Cite them by number in "sourceIds". Never invent stories, numbers, quotes or links.
- Stories marked "date: unknown" come from web search. Include one only if its text makes clear it is news from ${ctx.windowStart} to ${ctx.windowEnd}; otherwise leave it out.
- Several stories about the same event become one item citing all of them.
- Be selective: 5 to 12 items in total. If it was a slow week, say so and include fewer.
- Each "body" is 2 to 4 sentences: what happened, then why it matters for Unstream or the artists it serves. Plain, direct, no hype, no marketing voice.
- Group items into 2 to 5 sections with short headings of your choosing.
- "forUnstream" holds 0 to 3 concrete product ideas or open questions the week's news raises for Unstream. Leave it empty rather than pad it.

Reply with a single JSON object and nothing else, in exactly this shape:
{
  "title": "a short headline for the week, under 80 characters",
  "summary": "one sentence teaser for a feed reader",
  "intro": "2 to 3 sentences on the week's through-line",
  "sections": [
    { "heading": "string", "stories": [ { "headline": "string", "body": "string", "sourceIds": [1, 2] } ] }
  ],
  "forUnstream": ["string"]
}`;
}

export function buildUserPrompt(ctx: PromptContext, candidates: Candidate[]): string {
  const stories = candidates
    .map((c) => {
      const date = c.publishedAt ? c.publishedAt.slice(0, 10) : 'unknown';
      return `[${c.id}] ${c.title}\nsource: ${c.source} · date: ${date}\n${c.excerpt}`;
    })
    .join('\n\n');
  return `Week ${ctx.weekLabel} (${ctx.windowStart} to ${ctx.windowEnd}). ${candidates.length} candidate stories:\n\n${stories}`;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Pull the JSON object out of a model reply. Models wrap JSON in code fences or add a sentence
 * before it despite being told not to, so take the outermost braces.
 */
export function extractJson(reply: string): unknown {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('reply contains no JSON object');
  return JSON.parse(reply.slice(start, end + 1));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${field}" must be a non-empty string`);
  // One line each: a newline in model prose could otherwise start a heading or a list.
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Validate the model's JSON against the candidates it was given. Structural problems throw (the
 * caller retries once with the error); a story citing no id we handed out is dropped and
 * reported in `dropped`, since that is a story we can't link to and can't vouch for.
 */
export function validateDigest(
  value: unknown,
  validIds: Set<number>,
): { digest: Digest; dropped: string[] } {
  if (!value || typeof value !== 'object') throw new Error('reply is not a JSON object');
  const obj = value as Record<string, unknown>;
  const dropped: string[] = [];

  if (!Array.isArray(obj.sections)) throw new Error('"sections" must be an array');
  const sections: DigestSection[] = obj.sections.flatMap((rawSection: unknown, i: number) => {
    const section = rawSection as Record<string, unknown>;
    const heading = requireString(section?.heading, `sections[${i}].heading`);
    if (!Array.isArray(section.stories)) throw new Error(`"sections[${i}].stories" must be an array`);
    const stories = section.stories.flatMap((rawStory: unknown, j: number) => {
      const story = rawStory as Record<string, unknown>;
      const headline = requireString(story?.headline, `sections[${i}].stories[${j}].headline`);
      const body = requireString(story.body, `sections[${i}].stories[${j}].body`);
      const ids = Array.isArray(story.sourceIds) ? story.sourceIds : [];
      const sourceIds = [...new Set(ids.map(Number).filter((id) => validIds.has(id)))];
      if (sourceIds.length === 0) {
        dropped.push(headline);
        return [];
      }
      return [{ headline, body, sourceIds }];
    });
    return stories.length > 0 ? [{ heading, stories }] : [];
  });

  if (sections.length === 0) throw new Error('no story cites a valid source id');

  const forUnstream = Array.isArray(obj.forUnstream)
    ? obj.forUnstream
        .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        .map((s) => s.replace(/\s+/g, ' ').trim())
    : [];

  return {
    digest: {
      title: requireString(obj.title, 'title'),
      summary: requireString(obj.summary, 'summary'),
      intro: requireString(obj.intro, 'intro'),
      sections,
      forUnstream,
    },
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Escape the characters that would turn model prose into markdown links, images or HTML. */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\[\]<>])/g, '\\$1');
}

function quoteYaml(value: string): string {
  // parseFrontmatter (scripts/rss.ts) unescapes \" and nothing else, so escape only that.
  return `"${value.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

export function renderMarkdown(
  digest: Digest,
  candidates: Candidate[],
  meta: { week: string; published: string; model: string },
): string {
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const sections = digest.sections
    .map((section) => {
      const stories = section.stories
        .map((story) => {
          const links = story.sourceIds
            .map((id) => byId.get(id)!)
            .map((c) => `[${escapeMarkdown(c.source)}](<${c.url.replace(/[\s<>]/g, encodeURIComponent)}>)`)
            .join(' · ');
          return `### ${escapeMarkdown(story.headline)}\n\n${escapeMarkdown(story.body)}\n\n${links}`;
        })
        .join('\n\n');
      return `## ${escapeMarkdown(section.heading)}\n\n${stories}`;
    })
    .join('\n\n');

  const ideas = digest.forUnstream.length > 0
    ? `\n\n## For Unstream\n\n${digest.forUnstream.map((idea) => `- ${escapeMarkdown(idea)}`).join('\n')}`
    : '';

  return `---
title: ${quoteYaml(digest.title)}
week: ${meta.week}
published: ${meta.published}
summary: ${quoteYaml(digest.summary)}
model: ${meta.model}
---

${escapeMarkdown(digest.intro)}

${sections}${ideas}

---

_Compiled by ${meta.model} from ${candidates.length} stories. Every link above comes from a fetched feed or search result, not from the model._
`;
}

/** Every URL a digest cites, normalized — stored per week so later weeks don't repeat them. */
export function citedUrls(digest: Digest, candidates: Candidate[]): string[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return digest.sections.flatMap((s) => s.stories.flatMap((st) => st.sourceIds.map((id) => byId.get(id)!.url)));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** ISO 8601 week label, e.g. 2026-W40. Matches `date +%G-W%V`. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
