// Accent folding in artistSlug, and the letters NFD alone cannot handle.
//
// Fans reported being unable to find accented artists. The cause was not only an ugly URL: the
// mangled slug is what persistSearchResults upserts `on conflict (slug)`, so "Björk" typed with the
// umlaut and "Bjork" typed without produced two artist rows and two half-populated pages. Every
// case below is a real name measured against production on 2026-08-03.

import { describe, it, expect } from 'vitest';
import { artistSlug } from '../db';
import { foldToAscii, normalizeAccents } from '../search-utils';

describe('artistSlug — accents are folded, not turned into separators', () => {
  it.each([
    ['Björk', 'bjork'],
    ['Sébastien Tellier', 'sebastien-tellier'],
    ['Choan Gálvez', 'choan-galvez'],
    ['Das Mörtal', 'das-mortal'],
    ['Jónsi', 'jonsi'],
    ['Hüsker Dü', 'husker-du'],
    ['José González', 'jose-gonzalez'],
    ['Sigur Rós', 'sigur-ros'],
    ['Mötley Crüe', 'motley-crue'],
  ])('%s -> %s', (name, expected) => {
    expect(artistSlug(name)).toBe(expected);
  });

  it('no longer emits a hyphen where an accented letter stood', () => {
    // The old behaviour: /[^a-z0-9]+/ matched the accented character itself.
    expect(artistSlug('Björk')).not.toBe('bj-rk');
    expect(artistSlug('Sigur Rós')).not.toBe('sigur-r-s');
  });

  it('handles the letters NFD cannot decompose', () => {
    // These carry the stroke or slash in the codepoint, so there is no combining mark to remove and
    // normalizeAccents leaves them untouched. Without an explicit map they become hyphens — or
    // vanish, which is how "Łukasz" used to lose its first letter.
    expect(artistSlug('Błoto')).toBe('bloto');
    expect(artistSlug('Nørden')).toBe('norden');
    expect(artistSlug('Łukasz')).toBe('lukasz');
    expect(artistSlug('Æther')).toBe('aether');
    expect(artistSlug('Đevo')).toBe('devo');
  });

  it('keeps distinct artists distinct', () => {
    // Błoto (Polish jazz) and Boto are different acts. Before folding, both produced slugs that
    // collapsed together under comparison; the fold gives them separate URLs.
    expect(artistSlug('Błoto')).not.toBe(artistSlug('Boto'));
  });

  it('leaves plain ASCII names exactly as they were', () => {
    // The overwhelming majority of rows must not move, or every existing URL breaks.
    for (const [name, slug] of [
      ['Kid Lightbulbs', 'kid-lightbulbs'],
      ['Warren Harrison', 'warren-harrison'],
      ['girl in red', 'girl-in-red'],
      ['j:dead', 'j-dead'],
      ['Snap Infraction (feat. madeline)', 'snap-infraction-feat-madeline'],
      ['Various Artists', 'various-artists'],
    ]) {
      expect(artistSlug(name)).toBe(slug);
    }
  });

  it('still strips leading and trailing separators', () => {
    expect(artistSlug('!!! Wow !!!')).toBe('wow');
    expect(artistSlug('  spaced  ')).toBe('spaced');
  });

  it('never returns a slug outside [a-z0-9-]', () => {
    for (const name of ['Björk', 'Błoto', '日本語', 'Æther', 'Ångström', 'ß']) {
      expect(artistSlug(name)).toMatch(/^[a-z0-9-]*$/);
    }
  });
});

describe('foldToAscii', () => {
  it('does what normalizeAccents does, plus the non-decomposing letters', () => {
    expect(foldToAscii('Björk')).toBe('Bjork');
    expect(normalizeAccents('Błoto')).toBe('Błoto'); // NFD cannot touch it...
    expect(foldToAscii('Błoto')).toBe('Bloto');      // ...this can
  });

  it('preserves case', () => {
    expect(foldToAscii('ŁUKASZ')).toBe('LUKASZ');
    expect(foldToAscii('łukasz')).toBe('lukasz');
  });

  it('expands the multi-letter transliterations', () => {
    expect(foldToAscii('Æther')).toBe('Aether');
    expect(foldToAscii('Straße')).toBe('Strasse');
    expect(foldToAscii('Þór')).toBe('Thor');
  });

  it('leaves non-Latin scripts alone rather than mangling them', () => {
    // artistSlug drops these anyway; foldToAscii's job is Latin, and pretending otherwise would
    // invent transliterations nobody asked for.
    expect(foldToAscii('日本語')).toBe('日本語');
  });
});
