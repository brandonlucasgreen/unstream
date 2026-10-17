// @vitest-environment jsdom
// The Tip button in the extension popup (UNS-213, docs/specs/artist-tips-spec.md §6, §9 phase 4).
//
// What is worth pinning: who the button appears for (`tipsEnabled` and nothing else — the flag
// check is server-side, so a client-side guess here would be a second source of truth), the slug it
// deep-links with (the popup's own `claimedSlug || knownSlug` page slug, not the `id` fallback that
// is not a route), and that a click opens /tip/{slug} in a new tab while recording the click-out.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TIP_CLICK_METRIC,
  resultPageSlug,
  tipLabel,
  tipTooltip,
  tipTarget,
  tipPageUrl,
  openTipPage,
  renderTipButton,
} from '../../../../apps/extension/lib/tip-button.js';

const artistResult = (overrides = {}) => ({
  type: 'artist',
  name: 'Kid Lightbulbs',
  platforms: [],
  ...overrides,
});

describe('tipTarget', () => {
  it('finds the artist taking tips, by the same page slug the rest of the popup uses', () => {
    const results = [
      { type: 'platform', name: 'Bandcamp', platforms: [] },
      artistResult({ claimedSlug: 'kid-lightbulbs', tipsEnabled: true }),
    ];
    expect(tipTarget(results)).toEqual({ slug: 'kid-lightbulbs', artistName: 'Kid Lightbulbs' });
  });

  it('takes a known-only artist — most artists taking tips have not claimed a page', () => {
    const results = [artistResult({ knownSlug: 'kid-lightbulbs', tipsEnabled: true })];
    expect(tipTarget(results)).toEqual({ slug: 'kid-lightbulbs', artistName: 'Kid Lightbulbs' });
  });

  it('prefers the claimed slug when a result carries both', () => {
    const results = [artistResult({ claimedSlug: 'claimed-slug', knownSlug: 'known-slug', tipsEnabled: true })];
    expect(tipTarget(results)?.slug).toBe('claimed-slug');
  });

  it('is null when the server did not mark the result — tips off, unpublished, or flag off', () => {
    expect(tipTarget([artistResult()])).toBeNull();
    expect(tipTarget([artistResult({ tipsEnabled: false, claimedSlug: 'kid-lightbulbs' })])).toBeNull();
    // Anything truthy-but-not-true is not the contract: the server sets `true` or nothing at all.
    expect(tipTarget([artistResult({ tipsEnabled: 'yes', claimedSlug: 'kid-lightbulbs' })])).toBeNull();
  });

  it('is null without a slug, rather than falling back to the result id', () => {
    // `id` is 'known-<slug>' for stored cards and a platform-derived id otherwise. Neither is a
    // /tip/{slug} route, so a tip button built from one would 404.
    expect(tipTarget([artistResult({ id: 'known-kid-lightbulbs', tipsEnabled: true })])).toBeNull();
  });

  it('ignores results that are not artists, and empty or missing result sets', () => {
    expect(tipTarget([{ type: 'release', id: 'x', tipsEnabled: true, claimedSlug: 'x' }])).toBeNull();
    expect(tipTarget([])).toBeNull();
    expect(tipTarget(undefined)).toBeNull();
  });

  it('names the button from the result, falling back to the detected artist', () => {
    const results = [artistResult({ name: undefined, claimedSlug: 'kid-lightbulbs', tipsEnabled: true })];
    expect(tipTarget(results, 'Kid Lightbulbs')?.artistName).toBe('Kid Lightbulbs');
  });
});

describe('resultPageSlug', () => {
  it('is the artist page slug, claimed first', () => {
    expect(resultPageSlug(artistResult({ claimedSlug: 'a', knownSlug: 'b' }))).toBe('a');
    expect(resultPageSlug(artistResult({ knownSlug: 'b' }))).toBe('b');
    expect(resultPageSlug(artistResult())).toBeNull();
    expect(resultPageSlug(null)).toBeNull();
  });
});

describe('copy and URL', () => {
  it('uses the Mac contract word for word, and no fee maths', () => {
    // ArtistTipButton.swift: label "Tip {artistName}", help "Tip {artistName} in your browser.
    // The payment goes straight to their Stripe account." The tip page shows the fee before paying.
    expect(tipLabel('Kid Lightbulbs')).toBe('Tip Kid Lightbulbs');
    expect(tipTooltip('Kid Lightbulbs')).toBe(
      'Tip Kid Lightbulbs in your browser. The payment goes straight to their Stripe account.',
    );
  });

  it('points at the web tip page', () => {
    expect(tipPageUrl('kid-lightbulbs')).toBe('https://unstream.stream/tip/kid-lightbulbs');
    expect(tipPageUrl('a b')).toBe('https://unstream.stream/tip/a%20b');
  });
});

describe('openTipPage', () => {
  it('opens the tip page in a new tab and records both click-outs', () => {
    const open = vi.fn();
    const sendMessage = vi.fn();

    openTipPage({ slug: 'kid-lightbulbs' }, { open, sendMessage });

    expect(open).toHaveBeenCalledWith('https://unstream.stream/tip/kid-lightbulbs', '_blank', 'noopener');
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'TRACK_ANALYTICS',
      slug: 'kid-lightbulbs',
      metric: TIP_CLICK_METRIC,
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'TRACK_APP_EVENT',
      event_type: 'platform_click',
      context: { platform: 'tip' },
    });
  });

  it('does nothing without a target', () => {
    const open = vi.fn();
    const sendMessage = vi.fn();
    openTipPage(null, { open, sendMessage });
    expect(open).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('renderTipButton', () => {
  let slot: HTMLDivElement;

  beforeEach(() => {
    slot = document.createElement('div');
    slot.className = 'tip-button-slot hidden';
    document.body.replaceChildren(slot);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('renders a filled Tip button for a tips-enabled artist', () => {
    const button = renderTipButton(slot, { slug: 'kid-lightbulbs', artistName: 'Kid Lightbulbs' });

    expect(button).not.toBeNull();
    expect(slot.classList.contains('hidden')).toBe(false);
    expect(slot.querySelectorAll('button')).toHaveLength(1);
    expect(button?.className).toBe('tip-button');
    expect(button?.textContent).toContain('Tip Kid Lightbulbs');
  });

  it('carries the tooltip as the accessible name, like the Mac button', () => {
    const button = renderTipButton(slot, { slug: 'kid-lightbulbs', artistName: 'Kid Lightbulbs' });
    const tooltip = 'Tip Kid Lightbulbs in your browser. The payment goes straight to their Stripe account.';

    expect(button?.title).toBe(tooltip);
    expect(button?.getAttribute('aria-label')).toBe(tooltip);
    // The heart is decoration; the label is the text.
    expect(slot.querySelector('.tip-button-heart')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders nothing at all when the artist takes no tips', () => {
    const button = renderTipButton(slot, null);

    expect(button).toBeNull();
    expect(slot.children).toHaveLength(0);
    expect(slot.classList.contains('hidden')).toBe(true);
  });

  it('clears a previous artist\'s button when the next artist takes no tips', () => {
    renderTipButton(slot, { slug: 'kid-lightbulbs', artistName: 'Kid Lightbulbs' });
    renderTipButton(slot, null);

    expect(slot.children).toHaveLength(0);
    expect(slot.classList.contains('hidden')).toBe(true);
  });

  it('opens the tip page on click, through the popup\'s own analytics channel', () => {
    const open = vi.fn();
    const sendMessage = vi.fn();
    vi.stubGlobal('open', open);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const button = renderTipButton(slot, { slug: 'kid-lightbulbs', artistName: 'Kid Lightbulbs' });
    button?.click();

    expect(open).toHaveBeenCalledWith('https://unstream.stream/tip/kid-lightbulbs', '_blank', 'noopener');
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'TRACK_ANALYTICS',
      slug: 'kid-lightbulbs',
      metric: 'click:tip',
    });
  });
});
