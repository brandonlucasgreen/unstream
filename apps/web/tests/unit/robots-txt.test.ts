// public/robots.txt splits AI bots by purpose: the ones that read a page to answer or cite it are
// allowed, the ones that collect pages to train models are refused. It's a hand-written file with
// a subtle rule in it (a bot that matches a named group ignores the `*` group), so this pins the
// split the way a crawler reads it rather than the way the file looks.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const robotsTxt = readFileSync(resolve(__dirname, '../../public/robots.txt'), 'utf-8');

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

/** RFC 9309 groups: consecutive User-agent lines share the rules that follow them. */
function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [key, ...rest] = line.split(':');
    const field = key.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  return groups;
}

/** Whether `agent` may fetch `path`: its own group if named, else `*`; longest match wins, allow wins a tie. */
function isAllowed(agent: string, path = '/'): boolean {
  const groups = parseGroups(robotsTxt);
  const named = groups.filter(g => g.agents.includes(agent.toLowerCase()));
  const applicable = named.length > 0 ? named : groups.filter(g => g.agents.includes('*'));
  const matches = applicable
    .flatMap(g => g.rules)
    .filter(r => r.path !== '' && path.startsWith(r.path))
    .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matches.length === 0 || matches[0].allow;
}

const TRAINING_AGENTS = [
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'Applebot-Extended',
  'meta-externalagent',
  'CCBot',
  'Bytespider',
  'cohere-training-data-crawler',
  'AI2Bot',
  'Ai2Bot-Dolma',
];

// Search engines, and the AI bots that fetch a page to answer a question or cite it.
const ANSWER_AND_SEARCH_AGENTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'DuckAssistBot',
  'Meta-WebIndexer',
  'meta-externalfetcher',
  'Googlebot',
  'Bingbot',
  'Applebot',
  'Amazonbot',
];

describe('robots.txt', () => {
  it('lets everyone else crawl the whole site', () => {
    expect(isAllowed('SomeNewBot')).toBe(true);
    expect(isAllowed('SomeNewBot', '/a/kid-lightbulbs')).toBe(true);
  });

  it('points crawlers at the sitemap', () => {
    expect(robotsTxt).toMatch(/^Sitemap: https:\/\/unstream\.stream\/sitemap\.xml$/m);
  });

  it.each(TRAINING_AGENTS)('refuses the training crawler %s', agent => {
    expect(isAllowed(agent)).toBe(false);
    expect(isAllowed(agent, '/a/kid-lightbulbs')).toBe(false);
  });

  it.each(ANSWER_AND_SEARCH_AGENTS)('allows the answer or search bot %s', agent => {
    expect(isAllowed(agent)).toBe(true);
    expect(isAllowed(agent, '/a/kid-lightbulbs')).toBe(true);
  });

  // A bot named in any group stops reading `*`, so naming an answer bot would silently exempt it
  // from whatever is added to `*` later. They stay unnamed.
  it.each(ANSWER_AND_SEARCH_AGENTS)('does not name %s in any group', agent => {
    const named = parseGroups(robotsTxt).some(g => g.agents.includes(agent.toLowerCase()));
    expect(named).toBe(false);
  });
});
