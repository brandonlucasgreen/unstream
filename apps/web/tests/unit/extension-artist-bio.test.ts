// @vitest-environment jsdom
// Which bio the extension popup shows under the detected artist, and when Phase 2 may fill it.
// A bio under the wrong name is worse than none, so the matching is what's worth pinning.

import { describe, it, expect } from 'vitest';
import {
  bioSourceLabel,
  bioTarget,
  shouldFillBio,
  renderArtistBio,
} from '../../../../apps/extension/lib/artist-bio.js';

const bio = { text: 'Experimental rock.\n\nFrom Brooklyn.', source: 'bandcamp', sourceUrl: 'https://kid.bandcamp.com', truncated: false };

describe('bioSourceLabel', () => {
  it('names the platform, and has no label for the claimed artist\'s own bio', () => {
    expect(bioSourceLabel('bandcamp')).toBe('From Bandcamp');
    expect(bioSourceLabel('unstream')).toBeNull();
    expect(bioSourceLabel('wikipedia')).toBe('From Wikipedia · CC BY-SA');
  });
});

describe('bioTarget', () => {
  it('prefers an exact-name claimed card, and never a partial match', () => {
    const results = [
      { type: 'artist', name: 'Synthetic Ruby', matchConfidence: 'verified' },
      { type: 'artist', name: 'Ruby', matchConfidence: 'verified' },
      { type: 'artist', name: 'Ruby', matchConfidence: 'claimed' },
    ];
    expect(bioTarget(results, 'Ruby')).toBe(results[2]);
  });
});

describe('shouldFillBio', () => {
  const enrichment = { artistName: 'Kid Lightbulbs', bio };

  it('fills an empty, unclaimed card of the same name', () => {
    expect(shouldFillBio({ name: 'Kid Lightbulbs', matchConfidence: 'verified' }, enrichment)).toBe(true);
  });

  it('never replaces a bio, fills a claimed card, or crosses names', () => {
    expect(shouldFillBio({ name: 'Kid Lightbulbs', bio }, enrichment)).toBe(false);
    expect(shouldFillBio({ name: 'Kid Lightbulbs', matchConfidence: 'claimed' }, enrichment)).toBe(false);
    expect(shouldFillBio({ name: 'Kid Lightbulbs', bioSuppressed: true }, enrichment)).toBe(false);
    expect(shouldFillBio({ name: 'Kid', matchConfidence: 'verified' }, enrichment)).toBe(false);
  });
});

describe('renderArtistBio', () => {
  it('renders paragraphs as text and links to the source', () => {
    const container = document.createElement('div');
    renderArtistBio(container, { ...bio, text: '<b>not markup</b>' });
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>not markup</b>');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://kid.bandcamp.com');
    expect(link?.textContent).toBe('From Bandcamp ↗');
  });

  it("draws no source line for a claimed artist's own bio", () => {
    const container = document.createElement('div');
    renderArtistBio(container, { ...bio, source: 'unstream', sourceUrl: 'https://unstream.stream/a/kid' });
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).not.toContain('From the artist');
    expect(container.querySelector('.artist-bio-footer')?.classList.contains('hidden')).toBe(true);
  });

  it('refuses a non-web source URL', () => {
    const container = document.createElement('div');
    renderArtistBio(container, { ...bio, sourceUrl: 'javascript:alert(1)' });
    expect(container.querySelector('a')).toBeNull();
  });

  it('hides itself when there is no bio', () => {
    const container = document.createElement('div');
    renderArtistBio(container, null);
    expect(container.classList.contains('hidden')).toBe(true);
  });
});
