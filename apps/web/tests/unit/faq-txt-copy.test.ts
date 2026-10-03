// public/faq.txt must say what the FAQ page says: same questions, same answers, same order.
//
// The page renders src/data/faq.ts, the source of truth. faq.txt is a hand-kept plain-text copy for
// crawlers and LLMs, written as `### question` followed by the answer. Nothing regenerates it, and
// by October 2026 it had fallen behind on one question and five answers: the privacy answer still
// said "virtually nothing" after the page had been rewritten, the payout list lacked Subvert and
// Jam.coop, and the apps answer still said "not yet".
//
// faq.txt uses curly apostrophes where faq.ts uses straight ones, and a stray trailing space is not
// a difference, so both are normalized before comparing.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { faqSections } from '../../src/data/faq';

const faqTxt = readFileSync(resolve(__dirname, '../../public/faq.txt'), 'utf-8');

function normalize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** faq.txt's entries: each `### ` line is a question, and everything up to the next one is its answer. */
function parseFaqTxt(text: string): { title: string; content: string }[] {
  return text
    .split(/^### /m)
    .slice(1)
    .map((entry) => {
      const newline = entry.indexOf('\n');
      return { title: entry.slice(0, newline), content: entry.slice(newline + 1) };
    });
}

const txtEntries = parseFaqTxt(faqTxt);

describe('faq.txt matches the FAQ page', () => {
  it('has the same questions in the same order', () => {
    expect(txtEntries.map((entry) => normalize(entry.title))).toEqual(
      faqSections.map((section) => normalize(section.title)),
    );
  });

  it.each(faqSections.map((section, index) => [section.title, index] as const))(
    'has the same answer to "%s"',
    (_title, index) => {
      expect(normalize(txtEntries[index]?.content ?? '')).toBe(normalize(faqSections[index].content));
    },
  );
});
