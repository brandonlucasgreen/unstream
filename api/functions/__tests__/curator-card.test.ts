// What a curator's carousel says about itself (api/shared/curator-card.ts). The drawing is
// verified by eye; this covers the alt text, which is what a screen reader gets and what
// Instagram requires on every image Buffer sends.

import { describe, it, expect } from 'vitest';
import {
  CURATOR_CARD_SLIDES,
  MAX_CURATOR_ARTIST_CARDS,
  curatorCardAltText,
  type CuratorCardArtist,
} from '../../shared/curator-card';

const artist = (over: Partial<CuratorCardArtist> = {}): CuratorCardArtist => ({
  name: 'Honeycrush',
  location: 'Brooklyn',
  release: 'Luminaires',
  payout: '80-85%',
  platformName: 'Bandcamp',
  handle: 'honeycrush',
  ...over,
});

const frame = { kicker: 'Tonight on Night Shift', viaHandle: 'nightshift' };

describe('the slide set', () => {
  it('is a cover and an artist card, and leaves room for nine artists in a carousel of ten', () => {
    expect(CURATOR_CARD_SLIDES).toEqual(['cover', 'curator-artist']);
    expect(MAX_CURATOR_ARTIST_CARDS).toBe(9);
  });
});

describe('curatorCardAltText — the cover', () => {
  it('names the show and every artist on it', () => {
    expect(curatorCardAltText({ slide: 'cover', frame, artists: [artist(), artist({ name: 'AxWax' })] }))
      .toBe('Tonight on Night Shift: Honeycrush, AxWax.');
  });

  it('still says something when the curator set no kicker', () => {
    expect(curatorCardAltText({ slide: 'cover', frame: { kicker: null, viaHandle: null }, artists: [artist()] }))
      .toBe('On Unstream: Honeycrush.');
  });
});

describe('curatorCardAltText — an artist card', () => {
  it('describes everything the card shows', () => {
    expect(curatorCardAltText({ slide: 'curator-artist', frame, artist: artist() }))
      .toBe('Honeycrush from Brooklyn, Luminaires. Bandcamp pays them 80-85% of what you pay.');
  });

  // Each of these is the normal case for an indie artist, not an error, so the sentence has to
  // stay well-formed as they drop away one by one.
  it('drops the location, the release and the payout cleanly', () => {
    expect(curatorCardAltText({ slide: 'curator-artist', frame, artist: artist({ location: null }) }))
      .toBe('Honeycrush, Luminaires. Bandcamp pays them 80-85% of what you pay.');

    expect(curatorCardAltText({ slide: 'curator-artist', frame, artist: artist({ release: null }) }))
      .toBe('Honeycrush from Brooklyn. Bandcamp pays them 80-85% of what you pay.');

    expect(curatorCardAltText({ slide: 'curator-artist', frame, artist: artist({ payout: null }) }))
      .toBe('Honeycrush from Brooklyn, Luminaires.');
  });

  it('says only the name when nothing else is known', () => {
    expect(curatorCardAltText({
      slide: 'curator-artist',
      frame,
      artist: artist({ location: null, release: null, payout: null, platformName: null, handle: null }),
    })).toBe('Honeycrush.');
  });

  // The payout claim needs both halves: a figure with no platform names no shop, and a platform
  // with no figure would invent one.
  it('makes no payout claim without both the figure and the platform', () => {
    expect(curatorCardAltText({ slide: 'curator-artist', frame, artist: artist({ platformName: null }) }))
      .toBe('Honeycrush from Brooklyn, Luminaires.');
  });
});
