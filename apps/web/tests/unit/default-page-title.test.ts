import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DEFAULT_PAGE_TITLE } from 'src/data/seo';

// Pages that set their own title restore the default when they unmount. The default is also the
// <title> of the static shell, so there are three places it can be written. It was once pasted
// into five files and drifted; three pages were still restoring a title the site stopped using.
const WEB_DIR = join(__dirname, '..', '..');
const RETIRED_TITLE = 'Unstream - Support artists directly';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the default page title', () => {
  it('is the title and og:title of the static shell', () => {
    const shell = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
    expect(shell).toContain(`<title>${DEFAULT_PAGE_TITLE}</title>`);
    expect(shell).toContain(`<meta property="og:title" content="${DEFAULT_PAGE_TITLE}" />`);
  });

  it('is never written out by hand in a page', () => {
    const handTyped = sourceFiles(join(WEB_DIR, 'src'))
      .filter(path => !path.endsWith(join('data', 'seo.ts')))
      .filter(path => {
        const source = readFileSync(path, 'utf8');
        return source.includes(DEFAULT_PAGE_TITLE) || source.includes(RETIRED_TITLE);
      })
      .map(path => path.slice(WEB_DIR.length + 1));
    expect(handTyped).toEqual([]);
  });
});
