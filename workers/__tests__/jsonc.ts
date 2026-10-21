import { readFileSync } from 'node:fs';

/**
 * Read wrangler.jsonc (or a commented tsconfig) as JSON.
 *
 * A regex is not enough: the config holds the site CSP and several URLs, so `//` appears inside
 * strings and stripping it there would corrupt the values the tests are checking. This walks the
 * text instead, tracking whether it is inside a string, and only then treats `//` as a comment.
 */
export function readJsonc(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8');
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += char;
  }

  // Trailing commas, which JSONC allows and JSON.parse does not.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
