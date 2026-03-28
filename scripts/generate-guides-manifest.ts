/**
 * Generate guides-manifest.json from frontmatter in data/guides/*.md
 *
 * Each markdown file should have YAML frontmatter:
 *   ---
 *   title: My guide title
 *   description: One-line description for the index page
 *   pillar: artist-economics | platform-discovery | how-to | builder
 *   published: 2026-03-28
 *   ---
 *
 * Output: data/guides/guides-manifest.json
 * Usage: npx tsx scripts/generate-guides-manifest.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDES_DIR = join(__dirname, '..', 'data', 'guides');
const OUTPUT_PATH = join(GUIDES_DIR, 'guides-manifest.json');

interface GuideEntry {
  slug: string;
  title: string;
  description: string;
  pillar: string;
  published: string;
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fields[key] = value;
  }
  return fields;
}

function main() {
  const files = readdirSync(GUIDES_DIR).filter(f => f.endsWith('.md'));
  const guides: GuideEntry[] = [];

  for (const file of files) {
    const content = readFileSync(join(GUIDES_DIR, file), 'utf-8');
    const fm = parseFrontmatter(content);

    if (!fm) {
      console.warn(`Skipping ${file}: no frontmatter found`);
      continue;
    }

    const missing = ['title', 'description', 'pillar', 'published'].filter(k => !fm[k]);
    if (missing.length > 0) {
      console.warn(`Skipping ${file}: missing frontmatter fields: ${missing.join(', ')}`);
      continue;
    }

    guides.push({
      slug: basename(file, '.md'),
      title: fm.title,
      description: fm.description,
      pillar: fm.pillar,
      published: fm.published,
    });
  }

  // Sort newest first
  guides.sort((a, b) => b.published.localeCompare(a.published));

  writeFileSync(OUTPUT_PATH, JSON.stringify(guides, null, 2) + '\n');
  console.log(`Wrote ${guides.length} guides to ${OUTPUT_PATH}`);
}

main();
