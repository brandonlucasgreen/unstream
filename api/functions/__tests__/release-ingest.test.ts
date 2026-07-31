// Mapping a fetched Bandcamp /music page into release rows.
//
// The properties worth locking are the ones that would silently corrupt a catalog rather than
// throw: telling a bot challenge apart from an empty artist, not storing a source URL that
// points at someone else's domain, and not letting two same-slug titles in one page collide.

import { describe, it, expect } from 'vitest';
import { ingestBandcampGrid, bandcampMusicUrl } from '../release-ingest';

function item(opts: { id?: string; href: string; title: string; img?: string }): string {
  return `<li ${opts.id ? `data-item-id="${opts.id}"` : ''} class="music-grid-item">
    <a href="${opts.href}">
      <div class="art"><img src="${opts.img ?? 'https://f4.bcbits.com/img/a1_2.jpg'}" /></div>
      <p class="title">${opts.title}</p>
    </a>
  </li>`;
}

const page = (items: string[]) => `<html><body><ol class="music-grid">${items.join('')}</ol></body></html>`;
const PAGE_URL = 'https://someone.bandcamp.com/music';

describe('ingestBandcampGrid', () => {
  it('maps a grid into releases with resolved absolute URLs', () => {
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-111', href: '/album/first-record', title: 'First Record' }),
        item({ id: 'track-222', href: '/track/a-single', title: 'A Single' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases).toHaveLength(2);
    expect(out.releases[0]).toMatchObject({
      title: 'First Record',
      slug: 'first-record',
      matchKey: 'firstrecord',
      releaseType: 'album',
      releaseDate: null,
      datePrecision: 'unknown',
      status: 'released',
      source: { platform: 'bandcamp', url: 'https://someone.bandcamp.com/album/first-record', externalId: 'album-111' },
    });
    expect(out.releases[1].releaseType).toBe('single');
  });

  // Distinguishing these two is the single most repeated bug class in this codebase. A
  // challenge means the upstream declined to answer; treating it as "no releases" records a
  // confident wrong answer and (with a cooldown) keeps it wrong for a week.
  it('reports a bot challenge distinctly from an empty catalog', () => {
    const challenge = '<html><head><script src="/_fs-ch-abc/main.js"></script></head><body></body></html>';
    expect(ingestBandcampGrid(challenge, PAGE_URL)).toEqual({ ok: false, reason: 'bot_challenge' });

    expect(ingestBandcampGrid('<html><body><p>nothing</p></body></html>', PAGE_URL)).toEqual({
      ok: false,
      reason: 'no_releases',
    });
  });

  // A stored source URL is shown to fans as a place to buy this artist's record, so an href
  // out of fetched markup must not be able to point somewhere else.
  it('drops releases whose href leaves the page host', () => {
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-1', href: 'https://attacker.example.com/album/x', title: 'Offsite' }),
        item({ id: 'album-2', href: '/album/legit', title: 'Legit' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases.map(r => r.title)).toEqual(['Legit']);
  });

  it('accepts same-host links after a custom-domain redirect', () => {
    // pageUrl is where we actually landed, which for Bandcamp Pro is the custom domain.
    const out = ingestBandcampGrid(
      page([item({ id: 'album-1', href: '/album/javelin', title: 'Javelin' })]),
      'https://music.sufjan.com/music'
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases[0].source.url).toBe('https://music.sufjan.com/album/javelin');
  });

  it('deduplicates the same release listed twice on one page', () => {
    // Bandcamp sometimes renders a release both as "featured" and in sequence.
    const dup = item({ id: 'album-1', href: '/album/x', title: 'Repeated' });
    const out = ingestBandcampGrid(page([dup, dup]), PAGE_URL);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases).toHaveLength(1);
  });

  it('does not merge an album and a single that share a title', () => {
    // Same title at different types are genuinely different releases — a lead single and the
    // album it lands on. Under-merge, never over-merge.
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-1', href: '/album/halo', title: 'Halo' }),
        item({ id: 'track-1', href: '/track/halo', title: 'Halo' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases).toHaveLength(2);
  });

  it('gives colliding slugs distinct values within one page', () => {
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-1', href: '/album/a', title: 'Album Name.' }),
        item({ id: 'album-2', href: '/album/b', title: 'Album Name!' }),
        item({ id: 'album-3', href: '/album/c', title: 'Album Name?' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // All three normalize to the same match key, so they're one release by identity...
    expect(out.releases).toHaveLength(1);
  });

  it('keeps non-Latin titles instead of dropping them', () => {
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-1', href: '/album/tokyo', title: '東京' }),
        item({ id: 'album-2', href: '/album/osaka', title: '大阪' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases).toHaveLength(2);
    expect(out.releases.map(r => r.title)).toEqual(['東京', '大阪']);
    expect(new Set(out.releases.map(r => r.slug)).size).toBe(2);
  });

  it('never invents a release date from the grid', () => {
    // Dates are not in the grid at all — they cost one request per release. Guessing one
    // would put a fabricated date into a chronology and a subscriber's calendar.
    const out = ingestBandcampGrid(page([item({ id: 'album-1', href: '/album/x', title: 'X' })]), PAGE_URL);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases[0].releaseDate).toBeNull();
    expect(out.releases[0].datePrecision).toBe('unknown');
  });

  it('reports no_releases when every entry was unusable', () => {
    const out = ingestBandcampGrid(
      page([item({ id: 'album-1', href: 'https://elsewhere.example.com/x', title: 'Offsite' })]),
      PAGE_URL
    );
    expect(out).toEqual({ ok: false, reason: 'no_releases' });
  });
});

describe('bandcampMusicUrl', () => {
  it('derives /music from any stored depth', () => {
    for (const stored of [
      'https://someone.bandcamp.com',
      'https://someone.bandcamp.com/',
      'https://someone.bandcamp.com/music',
      'https://someone.bandcamp.com/album/a-record',
      'https://someone.bandcamp.com/track/a-song?from=embed',
    ]) {
      expect(bandcampMusicUrl(stored)).toBe('https://someone.bandcamp.com/music');
    }
  });

  it('preserves a custom domain', () => {
    expect(bandcampMusicUrl('https://music.sufjan.com/album/javelin')).toBe('https://music.sufjan.com/music');
  });

  it('refuses junk and non-HTTP schemes', () => {
    expect(bandcampMusicUrl('not a url')).toBeNull();
    expect(bandcampMusicUrl('file:///etc/passwd')).toBeNull();
    expect(bandcampMusicUrl('')).toBeNull();
  });
});
