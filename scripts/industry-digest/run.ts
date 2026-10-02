/**
 * Compile the weekly industry digest and publish it as an RSS feed.
 *
 *   1. Gather: fetch the feeds in sources.ts (last 7 days) and run its web searches through
 *      Ollama's web_search API.
 *   2. Select: de-duplicate, drop anything a digest from the last four weeks already cited, cap.
 *   3. Compile: one chat call to an Ollama cloud model, which picks and summarizes stories by id.
 *   4. Publish: write {week}.md + {week}.json into --out and rebuild --out/feed.xml.
 *
 * --out is a checkout of the `industry-digest` branch, which holds nothing but the digests and
 * the feed. The digest never touches `main` or the website: unlisted by living on a branch, not
 * private (the repo is public, so the raw feed URL works in any reader without a login), and
 * no Netlify deploy per issue. .github/workflows/industry-digest.yml runs this every Friday and
 * commits the result. scripts/industry-digest/README.md has the rest.
 *
 * Usage:
 *   npx tsx scripts/industry-digest/run.ts --out <dir>                 # Compile and publish
 *   npx tsx scripts/industry-digest/run.ts --out <dir> --gather-only   # Print candidates, no model call
 *
 * Environment:
 *   OLLAMA_API_KEY     - Required (web search and the model). --gather-only without it skips search.
 *   DIGEST_MODEL       - Optional Ollama cloud model, default gpt-oss:120b
 *   GITHUB_REPOSITORY  - Optional, for feed links (set by Actions), default brandonlucasgreen/unstream
 *   GITHUB_STEP_SUMMARY - Set by Actions; the run's source health report is appended to it
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { marked } from 'marked';

import { PLATFORMS } from '../../api/shared/platform-registry';
import { buildRssFeed, parseFrontmatter, type RssItem } from '../rss';
import {
  EXCERPT_CHARS,
  buildSystemPrompt,
  buildUserPrompt,
  citedUrls,
  extractJson,
  htmlToText,
  isoWeek,
  normalizeUrl,
  numberCandidates,
  parseFeed,
  renderMarkdown,
  selectCandidates,
  truncate,
  validateDigest,
  type Candidate,
  type Digest,
  type PromptContext,
  type RawCandidate,
} from './digest';
import { FEEDS, SEARCH_QUERIES } from './sources';

const OLLAMA_BASE = 'https://ollama.com/api';
const DEFAULT_MODEL = 'gpt-oss:120b';
const BRANCH = 'industry-digest';
const USER_AGENT = 'UnstreamIndustryDigest/1.0 (+https://unstream.stream)';

const WINDOW_DAYS = 7;
/** How many past weeks' citations to exclude, so a story that lingers in feeds isn't re-run. */
const LOOKBACK_WEEKS = 4;
const PER_SOURCE_CAP = 12;
const TOTAL_CAP = 90;
/** Issues kept in feed.xml. Older ones stay on the branch as markdown. */
const FEED_ISSUES = 26;

interface SourceHealth {
  name: string;
  status: 'ok' | 'failed';
  items: number;
  error?: string;
}

function parseArgs(argv: string[]): { out: string; gatherOnly: boolean } {
  const outIndex = argv.indexOf('--out');
  const out = outIndex !== -1 ? argv[outIndex + 1] : undefined;
  if (!out) {
    console.error('Usage: npx tsx scripts/industry-digest/run.ts --out <dir> [--gather-only]');
    process.exit(1);
  }
  return { out, gatherOnly: argv.includes('--gather-only') };
}

async function fetchFeed(source: { name: string; url: string }): Promise<RawCandidate[]> {
  const response = await fetch(source.url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseFeed(await response.text(), source.name);
}

async function ollama<T>(path: string, apiKey: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const response = await fetch(`${OLLAMA_BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Ollama ${path} returned HTTP ${response.status}: ${truncate(await response.text(), 300)}`);
  }
  return (await response.json()) as T;
}

async function webSearch(query: string, apiKey: string): Promise<RawCandidate[]> {
  const data = await ollama<{ results?: { title?: string; url?: string; content?: string }[] }>(
    '/web_search',
    apiKey,
    { query, max_results: 10 },
  );
  return (data.results ?? []).flatMap((r) => {
    if (!r.title || !r.url || !/^https?:\/\//.test(r.url)) return [];
    return [{
      title: htmlToText(r.title),
      url: r.url,
      source: new URL(r.url).hostname.replace(/^www\./, ''),
      publishedAt: null,
      excerpt: truncate(htmlToText(r.content ?? ''), EXCERPT_CHARS),
      origin: 'search' as const,
    }];
  });
}

/**
 * Fail early with the list of available models if the configured one isn't served — the likeliest
 * breakage, since Ollama's cloud catalogue changes. A failed lookup only warns: the chat call
 * below is the real test.
 */
async function checkModel(model: string, apiKey: string): Promise<void> {
  let names: string[];
  try {
    const data = await ollama<{ models?: { name?: string; model?: string }[] }>('/tags', apiKey);
    names = (data.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => !!n);
  } catch (error) {
    console.warn(`::warning::Could not list Ollama models (${(error as Error).message}); trying ${model} anyway`);
    return;
  }
  if (names.length > 0 && !names.includes(model)) {
    throw new Error(
      `Model "${model}" is not in Ollama's cloud catalogue. Set the DIGEST_MODEL repository variable to one of: ${[...new Set(names)].sort().join(', ')}`,
    );
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chat(model: string, apiKey: string, messages: ChatMessage[]): Promise<string> {
  const data = await ollama<{ message?: { content?: string } }>(
    '/chat',
    apiKey,
    { model, messages, stream: false, options: { temperature: 0.3 } },
    10 * 60_000,
  );
  const content = data.message?.content ?? '';
  if (!content.trim()) throw new Error('Ollama returned an empty reply');
  return content;
}

/** One chat call, plus one retry that hands the model its own validation error. */
async function compile(
  model: string,
  apiKey: string,
  ctx: PromptContext,
  candidates: Candidate[],
): Promise<{ digest: Digest; dropped: string[] }> {
  const validIds = new Set(candidates.map((c) => c.id));
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(ctx) },
    { role: 'user', content: buildUserPrompt(ctx, candidates) },
  ];

  const first = await chat(model, apiKey, messages);
  try {
    return validateDigest(extractJson(first), validIds);
  } catch (error) {
    console.warn(`::warning::First reply was invalid (${(error as Error).message}); retrying once`);
    messages.push(
      { role: 'assistant', content: first },
      { role: 'user', content: `That reply was invalid: ${(error as Error).message}. Reply again with only the JSON object, in the shape described.` },
    );
    return validateDigest(extractJson(await chat(model, apiKey, messages)), validIds);
  }
}

function readPreviouslyCited(out: string, currentWeek: string): Set<string> {
  const weeks = readdirSync(out)
    .filter((f) => /^\d{4}-W\d{2}\.json$/.test(f) && f !== `${currentWeek}.json`)
    .sort()
    .slice(-LOOKBACK_WEEKS);
  const urls = new Set<string>();
  for (const file of weeks) {
    const record = JSON.parse(readFileSync(join(out, file), 'utf-8')) as { citedUrls?: string[] };
    for (const url of record.citedUrls ?? []) urls.add(normalizeUrl(url));
  }
  return urls;
}

function writeFeed(out: string, repo: string, now: Date): number {
  const items: RssItem[] = readdirSync(out)
    .filter((f) => /^\d{4}-W\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .slice(0, FEED_ISSUES)
    .map((file) => {
      const parsed = parseFrontmatter(readFileSync(join(out, file), 'utf-8'));
      if (!parsed) throw new Error(`${file} has no frontmatter`);
      const week = file.replace(/\.md$/, '');
      return {
        title: parsed.fields.title,
        link: `https://github.com/${repo}/blob/${BRANCH}/${file}`,
        guid: `unstream-industry-digest-${week}`,
        pubDate: parsed.fields.published,
        description: parsed.fields.summary,
        contentHtml: marked.parse(parsed.body, { async: false }) as string,
      };
    });

  const feed = buildRssFeed(
    {
      title: 'Unstream industry digest',
      description: 'A weekly, LLM-compiled digest of music-industry news relevant to Unstream. Unlisted.',
      link: `https://github.com/${repo}/tree/${BRANCH}`,
      feedUrl: `https://raw.githubusercontent.com/${repo}/${BRANCH}/feed.xml`,
    },
    items,
    now,
  );
  writeFileSync(join(out, 'feed.xml'), feed);
  return items.length;
}

function reportHealth(health: SourceHealth[], lines: string[]): void {
  const table = [
    '| Source | Status | Items |',
    '| --- | --- | --- |',
    ...health.map((h) => `| ${h.name} | ${h.status === 'ok' ? 'ok' : `failed: ${h.error}`} | ${h.items} |`),
  ];
  const report = [...lines, '', ...table, ''].join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

async function main() {
  const { out, gatherOnly } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OLLAMA_API_KEY ?? '';
  const model = process.env.DIGEST_MODEL || DEFAULT_MODEL;
  const repo = process.env.GITHUB_REPOSITORY || 'brandonlucasgreen/unstream';
  if (!apiKey && !gatherOnly) throw new Error('OLLAMA_API_KEY is not set');
  mkdirSync(out, { recursive: true });

  const now = new Date();
  const week = isoWeek(now);
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const ctx: PromptContext = {
    platforms: Object.values(PLATFORMS).map(
      (p) => `${p.name} (${p.category}${p.payoutPercent ? `, ${p.payoutPercent} to artists` : ''})`,
    ),
    weekLabel: week,
    windowStart: since.toISOString().slice(0, 10),
    windowEnd: now.toISOString().slice(0, 10),
  };

  if (apiKey && !gatherOnly) await checkModel(model, apiKey);

  const health: SourceHealth[] = [];
  const feedResults = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const items = await fetchFeed(feed);
        health.push({ name: feed.name, status: 'ok', items: items.length });
        return items;
      } catch (error) {
        const message = (error as Error).message;
        console.warn(`::warning::Feed ${feed.name} failed: ${message}`);
        health.push({ name: feed.name, status: 'failed', items: 0, error: message });
        return [];
      }
    }),
  );
  if (health.every((h) => h.status === 'failed')) {
    throw new Error('Every feed failed — refusing to publish a digest built from search alone');
  }

  const searchResults = apiKey
    ? await Promise.all(
        SEARCH_QUERIES.map(async (query) => {
          try {
            const items = await webSearch(query, apiKey);
            health.push({ name: `search: ${query}`, status: 'ok', items: items.length });
            return items;
          } catch (error) {
            const message = (error as Error).message;
            console.warn(`::warning::Search "${query}" failed: ${message}`);
            health.push({ name: `search: ${query}`, status: 'failed', items: 0, error: message });
            return [];
          }
        }),
      )
    : [];

  const previouslyCited = readPreviouslyCited(out, week);
  const candidates = numberCandidates(
    selectCandidates([...feedResults.flat(), ...searchResults.flat()], {
      since,
      previouslyCited,
      perSourceCap: PER_SOURCE_CAP,
      totalCap: TOTAL_CAP,
    }),
  );
  if (candidates.length === 0) throw new Error('No candidate stories in the window — check the source report');

  const summaryLines = [
    `## Industry digest ${week}`,
    '',
    `${candidates.length} candidate stories (${previouslyCited.size} URLs excluded as already cited). Model: ${model}.`,
  ];

  if (gatherOnly) {
    reportHealth(health, summaryLines);
    console.log(buildUserPrompt(ctx, candidates));
    return;
  }

  const { digest, dropped } = await compile(model, apiKey, ctx, candidates);
  const storyCount = digest.sections.reduce((n, s) => n + s.stories.length, 0);
  summaryLines.push('', `Published ${storyCount} stories in ${digest.sections.length} sections: **${digest.title}**`);
  if (dropped.length > 0) {
    summaryLines.push('', `Dropped ${dropped.length} stories that cited no valid source: ${dropped.join('; ')}`);
  }

  writeFileSync(
    join(out, `${week}.md`),
    renderMarkdown(digest, candidates, { week, published: now.toISOString().slice(0, 10), model }),
  );
  writeFileSync(
    join(out, `${week}.json`),
    `${JSON.stringify({ week, model, generatedAt: now.toISOString(), candidates: candidates.length, citedUrls: citedUrls(digest, candidates) }, null, 2)}\n`,
  );
  const issues = writeFeed(out, repo, now);
  summaryLines.push('', `feed.xml now holds ${issues} issue${issues === 1 ? '' : 's'}.`);

  if (!existsSync(join(out, 'README.md'))) {
    writeFileSync(
      join(out, 'README.md'),
      `# Unstream industry digest\n\nWeekly, LLM-compiled music-industry news for Unstream. Generated by \`scripts/industry-digest/\` on \`main\` — don't edit this branch by hand.\n\nFeed: https://raw.githubusercontent.com/${repo}/${BRANCH}/feed.xml\n`,
    );
  }

  reportHealth(health, summaryLines);
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exit(1);
});
