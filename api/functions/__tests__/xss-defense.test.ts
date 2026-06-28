// Tests for the XSS defense in the u-handle edge function and saved-artists save path.
// The edge function itself uses Deno imports and can't run under vitest, but the
// escapeHtml function and slug validation regex are replicated here to verify
// the security contract: artist slugs are escaped in SSR output and validated on save.

import { describe, it, expect } from 'vitest';

// Mirror of escapeHtml in api/edge/u-handle.ts — kept in sync.
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Mirror of the slug validation regex in api/functions/saved-artists.ts handleSave.
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;

describe('XSS defense: escapeHtml applied to artist slug in edge function SSR', () => {
  it('escapes & < > " and \' in slug values', () => {
    const maliciousSlug = `"><img src=x onerror=alert(1)>`;
    const escaped = escapeHtml(maliciousSlug);
    // The escaped string must not contain raw < > " '
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain("'");
    // And must contain the entity equivalents
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('&lt;');
    expect(escaped).toContain('&gt;');
  });

  it('produces a safe href when slug is escaped', () => {
    const slug = `"><script>alert(1)</script>`;
    const escapedSlug = escapeHtml(slug);
    const profileUrl = `https://unstream.stream/a/${escapedSlug}`;
    // The href must not contain a breakout from the attribute
    expect(profileUrl).not.toMatch(/"[^"]*>/);
    expect(profileUrl).not.toContain('<script>');
  });

  it('escapes ampersand in slug', () => {
    const slug = 'a&b';
    expect(escapeHtml(slug)).toBe('a&amp;b');
  });

  it('escapes single quote in slug', () => {
    const slug = `a'b`;
    expect(escapeHtml(slug)).toBe('a&#39;b');
  });

  it('preserves safe slug characters', () => {
    const slug = 'radiohead';
    expect(escapeHtml(slug)).toBe('radiohead');
  });
});

describe('XSS defense: slug validation on save rejects malicious slugs', () => {
  it('rejects a slug with double-quote (HTML attribute breakout)', () => {
    const slug = `"><img src=x onerror=alert(1)>`;
    expect(SLUG_REGEX.test(slug)).toBe(false);
  });

  it('rejects a slug with angle brackets', () => {
    const slug = '<script>';
    expect(SLUG_REGEX.test(slug)).toBe(false);
  });

  it('rejects a slug with spaces', () => {
    expect(SLUG_REGEX.test('bad slug')).toBe(false);
  });

  it('rejects a slug with uppercase letters', () => {
    expect(SLUG_REGEX.test('BadSlug')).toBe(false);
  });

  it('rejects a slug that is too short (< 3 chars)', () => {
    expect(SLUG_REGEX.test('ab')).toBe(false);
  });

  it('rejects a slug with leading hyphen', () => {
    expect(SLUG_REGEX.test('-bad')).toBe(false);
  });

  it('rejects a slug with trailing hyphen', () => {
    expect(SLUG_REGEX.test('bad-')).toBe(false);
  });

  it('accepts a valid slug', () => {
    expect(SLUG_REGEX.test('radiohead')).toBe(true);
  });

  it('accepts a valid slug with hyphens', () => {
    expect(SLUG_REGEX.test('the-beatles')).toBe(true);
  });

  it('accepts a valid slug with numbers', () => {
    expect(SLUG_REGEX.test('2pac')).toBe(true);
  });
});