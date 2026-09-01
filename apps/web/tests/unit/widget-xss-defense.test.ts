// Tests for the XSS defense in the embeddable widget (apps/web/public/widget.js).
// widget.js is a plain script served as a static asset and can't be imported directly under
// vitest, so its escapeHtml function is mirrored here to verify the security contract: artist
// name, artist image URL, and platform link URLs are attribute-safe when concatenated into the
// widget's HTML string.

import { describe, it, expect } from 'vitest';

// Mirror of escapeHtml in apps/web/public/widget.js — kept in sync.
function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

describe('XSS defense: escapeHtml in the embeddable widget', () => {
  it('escapes & < > " and \' in artist/link values', () => {
    const malicious = `"><img src=x onerror=alert(1)>`;
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain("'");
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('&lt;');
    expect(escaped).toContain('&gt;');
  });

  it('produces a safe href when a platform link URL carries a double quote', () => {
    // Simulates renderWidget's `href="' + escapeHtml(link.url) + '"'` concatenation.
    const url = `https://evil.example/x" onmouseover="alert(1)`;
    const href = `<a href="${escapeHtml(url)}">`;
    // Exactly the two delimiting quotes of the href attribute should remain raw — none of the
    // attacker's payload may introduce a literal " that closes the attribute early.
    expect(href.split('"').length - 1).toBe(2);
    expect(href).toContain('&quot;');
  });

  it('produces a safe src when an artist image URL carries a double quote', () => {
    // Simulates renderWidget's `src="' + escapeHtml(artist.imageUrl) + '"'` concatenation.
    const imageUrl = `https://evil.example/x.png" onerror="alert(1)`;
    const img = `<img src="${escapeHtml(imageUrl)}" />`;
    expect(img.split('"').length - 1).toBe(2);
  });

  it('escapes single and double quotes distinctly', () => {
    expect(escapeHtml(`a"b`)).toBe('a&quot;b');
    expect(escapeHtml(`a'b`)).toBe('a&#39;b');
  });

  it('preserves safe artist name characters', () => {
    expect(escapeHtml('Radiohead')).toBe('Radiohead');
  });
});
