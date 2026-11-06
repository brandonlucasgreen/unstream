// The release page can't render the React Header and Footer (it is pure SSR, nothing hydrates),
// so api/shared/site-chrome.ts draws them as HTML. It drifted once already when it was hand-rolled
// inside the page; these pin its links to the components'.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  FOOTER_LINKS,
  FOOTER_MADE_WITH_LOVE,
  HEADER_LOGIN_LINK,
  HEADER_NAV_LINKS,
  siteFooterHtml,
  siteHeaderHtml,
} from '../../../../api/shared/site-chrome';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const header = read('../../src/components/Header.tsx');
const footer = read('../../src/components/Footer.tsx');
const strings = JSON.parse(read('../../../../api/shared/locales/en/common.json'));

describe('site header', () => {
  it("has Header.tsx's signed-out nav, in order", () => {
    // Top-level entries only: nested keys like nav.account.myArtists don't match.
    const entries = [...header.matchAll(/\{ to: '([^']+)', label: t\('nav\.(\w+)'\)(, button: true)? \}/g)]
      .map(m => ({ href: m[1], label: strings.nav[m[2]] }));
    expect(entries).toEqual([...HEADER_NAV_LINKS, HEADER_LOGIN_LINK]);
  });

  it('links every nav item in both the inline nav and the menu', () => {
    const html = siteHeaderHtml();
    for (const link of [...HEADER_NAV_LINKS, HEADER_LOGIN_LINK]) {
      expect(html.split(`<a href="${link.href}"`).length - 1).toBe(2);
    }
  });

  it('searches through the SPA, never /search', () => {
    const html = siteHeaderHtml();
    expect(html).toContain('action="/" method="get"');
    expect(html).not.toContain('action="/search"');
  });
});

describe('site footer', () => {
  it("has Footer.tsx's links, in order", () => {
    const links = [...footer.matchAll(/<Link to="([^"]+)"[^>]*>\{t\('footer\.(\w+)'\)\}<\/Link>/g)]
      .map(m => ({ href: m[1], label: strings.footer[m[2]] }));
    expect(links).toEqual(FOOTER_LINKS);
  });

  it("has Footer.tsx's credit line", () => {
    expect(footer).toContain(`href="${FOOTER_MADE_WITH_LOVE.href}"`);
    expect(strings.footer.madeWithLove).toBe(FOOTER_MADE_WITH_LOVE.label);
  });

  it('renders every link', () => {
    const html = siteFooterHtml();
    for (const link of [FOOTER_MADE_WITH_LOVE, ...FOOTER_LINKS]) {
      expect(html).toContain(`<a href="${link.href}"`);
      expect(html).toContain(`>${link.label}</a>`);
    }
  });
});
