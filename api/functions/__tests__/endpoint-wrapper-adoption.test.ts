import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every function is on the shared endpoint wrapper (api/functions/http/endpoint.ts), and none
 * hand-writes the preflight, CORS, auth, rate limit or JSON parse the wrapper does for it.
 *
 * The wrapper was introduced on 2026-11-16 with twelve functions on it and a list here of the 63
 * still to move. That list is gone because it is empty: a new function passes this file only by
 * being declared with `endpoint({...})`, so there is no second way to write one.
 */

const functionsDir = join(__dirname, '..');
const exportsHandler = /export const handler = /;
const usesWrapper = /export const handler = withSentry\(endpoint\(/;

const source = (name: string) => readFileSync(join(functionsDir, name), 'utf8');
const functionFiles = readdirSync(functionsDir)
  .filter((name) => name.endsWith('.ts'))
  .filter((name) => exportsHandler.test(source(name)));

describe('every function is on the endpoint wrapper', () => {
  it('finds the functions', () => {
    // 76 on 2026-11-16. A floor, not a count to keep in step: it is here so a change to how
    // handlers are exported can't leave this file checking nothing.
    expect(functionFiles.length).toBeGreaterThanOrEqual(76);
  });

  it.each(functionFiles)('%s exports its handler as withSentry(endpoint({...}))', (name) => {
    expect(source(name)).toMatch(usesWrapper);
  });

  // The wrapper owns these, so a function that also does one by hand has two answers to the
  // same question, and the hand-written one is the one nobody checks. Comments count: a comment
  // naming one of these is describing work the function no longer does.
  it.each(functionFiles)('%s leaves the preamble to the wrapper', (name) => {
    const text = source(name);
    // CORS
    expect(text).not.toMatch(/buildAccountCorsHeaders|buildCorsHeaders|buildPublicCorsHeaders|Access-Control-Allow-/);
    // Who is asking
    expect(text).not.toMatch(/authenticateBearer|authenticateAdmin|authenticateApiKey|isInternalRequest/);
    expect(text).not.toMatch(/resolveAccountRequest|sessionMissingSecondFactor|auth\.getUser/);
    // How often
    expect(text).not.toMatch(/checkRateLimit\(|checkApiRateLimit/);
    // Which method, and the body
    expect(text).not.toMatch(/httpMethod/);
    expect(text).not.toMatch(/JSON\.parse\(event\.body/);
  });
});

describe('the folders of helpers are not deployed as functions', () => {
  // Netlify deploys a subfolder as a function when it holds index.* or a file named after the
  // folder (the same rule that keeps api/functions/db/ a plain folder of helpers).
  it.each(['index.ts', 'index.js', 'http.ts', 'http.js'])('http/ holds no %s', (name) => {
    expect(existsSync(join(functionsDir, 'http', name))).toBe(false);
  });
});
