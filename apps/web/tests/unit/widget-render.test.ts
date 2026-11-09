// @vitest-environment jsdom
// Runs the real public/widget.js — the file artists paste onto their sites, and the one the embed
// preview on the artist page draws with — against a stubbed fetch.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_MARKS } from '../../../../api/shared/platform-logos';

const widgetSource = readFileSync(path.resolve(__dirname, '../../public/widget.js'), 'utf8');

const artist = {
  name: 'Kid Lightbulbs',
  platforms: [
    { sourceId: 'officialsite', url: 'https://kidlightbulbs.com' },
    { sourceId: 'subvert', url: 'https://subvert.fm/kidlightbulbs' },
    { sourceId: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com' },
  ],
};

function addWidget(attrs: Record<string, string>) {
  const el = document.createElement('div');
  el.className = 'unstream-widget';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

const shadowOf = (el: HTMLElement) => el.shadowRoot!.querySelector('.uw-root')!;

describe('widget.js', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(artist) });
    vi.stubGlobal('fetch', fetchMock);
    delete (window as { UnstreamWidget?: unknown }).UnstreamWidget;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('looks the artist up by data-slug when the embed carries one', async () => {
    const el = addWidget({ 'data-artist': 'Kid Lightbulbs', 'data-slug': 'xkidlightbulbs' });
    (0, eval)(widgetSource);
    await vi.waitFor(() => expect(shadowOf(el).querySelector('.uw-link')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('https://unstream.stream/api/artist?slug=xkidlightbulbs');
    expect(shadowOf(el).querySelector('.uw-header')!.getAttribute('href')).toBe('https://unstream.stream/a/xkidlightbulbs');
  });

  it('still guesses the slug from the name for embeds copied before data-slug', async () => {
    addWidget({ 'data-artist': 'Kid Lightbulbs' });
    (0, eval)(widgetSource);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('https://unstream.stream/api/artist?slug=kid-lightbulbs');
  });

  it('draws each link with the platform mark the site uses, Subvert included', async () => {
    const el = addWidget({ 'data-artist': 'Kid Lightbulbs' });
    (0, eval)(widgetSource);
    await vi.waitFor(() => expect(shadowOf(el).querySelectorAll('.uw-link')).toHaveLength(3));
    const links = [...shadowOf(el).querySelectorAll('.uw-link')];
    expect(links.map((a) => a.textContent)).toEqual(['Bandcamp', 'Subvert', '⭐Official Site']);
    expect(links[0].querySelector('path')!.getAttribute('d')).toBe(PLATFORM_MARKS.bandcamp.d);
    expect(links[1].querySelector('path')!.getAttribute('d')).toBe(PLATFORM_MARKS.subvert.d);
    expect(links[0].querySelector('svg')!.getAttribute('fill')).toBe('currentColor');
  });

  it('draws widgets added after it ran, through UnstreamWidget.init, fetching the artist once', async () => {
    const first = addWidget({ 'data-artist': 'Kid Lightbulbs', 'data-theme': 'dark' });
    (0, eval)(widgetSource);
    await vi.waitFor(() => expect(shadowOf(first).querySelector('.uw-link')).toBeTruthy());

    const second = addWidget({ 'data-artist': 'Kid Lightbulbs', 'data-theme': 'light' });
    (window as unknown as { UnstreamWidget: { init: () => void } }).UnstreamWidget.init();
    await vi.waitFor(() => expect(shadowOf(second).querySelector('.uw-link')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('draws in the colours the artist picked, and ignores anything that is not a hex colour', async () => {
    const custom = addWidget({ 'data-artist': 'Kid Lightbulbs', 'data-bg': '#123456', 'data-text': '#fc0' });
    const bad = addWidget({ 'data-artist': 'Kid Lightbulbs', 'data-theme': 'light', 'data-bg': 'red; } * { display: none', 'data-text': 'url(x)' });
    (0, eval)(widgetSource);
    await vi.waitFor(() => expect(shadowOf(bad).querySelector('.uw-link')).toBeTruthy());

    const customCss = custom.shadowRoot!.querySelector('style')!.textContent!;
    expect(customCss).toContain('.uw-root { font-family: "Stack Sans Headline", system-ui, sans-serif; background: #123456;');
    expect(customCss).toContain('color: #ffcc00;');
    expect(customCss).toContain('rgba(255,204,0,0.08)');

    const badCss = bad.shadowRoot!.querySelector('style')!.textContent!;
    expect(badCss).toContain('background: #ffffff;');
    expect(badCss).not.toContain('display: none');
    expect(badCss).not.toContain('url(x)');
  });

  it('draws an emoji icon as a silhouette in the text colour, like the marks', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(artist) });
    const el = addWidget({ 'data-artist': 'Kid Lightbulbs', 'data-text': '#112233' });
    (0, eval)(widgetSource);
    await vi.waitFor(() => expect(shadowOf(el).querySelector('.uw-emoji')).toBeTruthy());
    expect(shadowOf(el).querySelector('.uw-emoji')!.textContent).toBe('\u2B50');
    expect(el.shadowRoot!.querySelector('style')!.textContent).toContain(
      '.uw-emoji { color: transparent; text-shadow: 0 0 0 #112233;'
    );
  });

  it('forgets a failed lookup, so the next widget tries again', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const first = addWidget({ 'data-artist': 'Kid Lightbulbs' });
    (0, eval)(widgetSource);
    await vi.waitFor(() => expect(shadowOf(first).textContent).toContain('Could not load artist data.'));

    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(artist) });
    const second = addWidget({ 'data-artist': 'Kid Lightbulbs' });
    (window as unknown as { UnstreamWidget: { init: () => void } }).UnstreamWidget.init();
    await vi.waitFor(() => expect(shadowOf(second).querySelector('.uw-link')).toBeTruthy());
  });
});
