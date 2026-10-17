// @vitest-environment jsdom
// /faq#tipping: every question carries an anchor (explicit where deep links need one, faq-<index>
// otherwise), and a hash link opens and scrolls to the question it names. This is the target of the
// tip pages' "How tipping works" link (UNS-219) — before this, the FAQ had no anchors at all, so a
// hash link couldn't land on an answer.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));

import { FaqPage } from 'src/pages/FaqPage';
import { faqSections, TIP_FAQ_ANCHOR } from 'src/data/faq';

afterEach(() => {
  cleanup();
  window.location.hash = '';
  vi.restoreAllMocks();
});

describe('FaqPage hash anchors', () => {
  it('gives every question a stable anchor (explicit where one is declared, faq-<index> otherwise)', () => {
    expect(TIP_FAQ_ANCHOR).toBe('tipping');
    render(<FaqPage />);
    faqSections.forEach((section, index) => {
      const el = document.getElementById(section.anchor ?? `faq-${index}`);
      expect(el).toBeTruthy();
      expect(el!.querySelector('summary')?.textContent).toContain(section.title.slice(0, 30));
    });
  });

  it('opens and scrolls to the question a #tipping hash names', () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.location.hash = `#${TIP_FAQ_ANCHOR}`;
    render(<FaqPage />);
    expect((document.getElementById(TIP_FAQ_ANCHOR) as HTMLDetailsElement).open).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('questions stay closed when the hash names no anchor, and nothing scrolls', () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.location.hash = '#no-such-question';
    render(<FaqPage />);
    expect((document.getElementById(TIP_FAQ_ANCHOR) as HTMLDetailsElement).open).toBe(false);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});