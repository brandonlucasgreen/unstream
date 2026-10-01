// Which slides an Instagram carousel gets and what their alt text says (api/shared/social-card.ts).
// The generator and the renderer both read these, so a wrong answer here is a card that's
// missing, or one whose alt text describes something it doesn't show.

import { describe, it, expect } from 'vitest';
import {
  cardAltText,
  cardFontsCanDraw,
  cardImageUrl,
  cardSlides,
  photoSource,
  socialCardUrl,
  type CardData,
} from '../../shared/social-card';

function card(overrides: Partial<CardData> = {}): CardData {
  return {
    artistName: 'Kid Lightbulbs',
    location: 'Boston',
    platform: { id: 'bandcamp', name: 'Bandcamp', payout: '80-85%' },
    release: { title: 'any day now', type: 'album', latest: true, artworkUrl: 'https://f4.bcbits.com/img/a1_2.jpg' },
    imageUrl: 'https://f4.bcbits.com/img/0032895476_23.jpg',
    ...overrides,
  };
}

describe('cardSlides', () => {
  it('has all four slides, photo last, when there is something for each', () => {
    expect(cardSlides(card())).toEqual(['buy', 'record', 'math', 'photo']);
  });

  it('leaves out a slide with nothing to put on it', () => {
    expect(cardSlides(card({ release: null }))).toEqual(['buy', 'math', 'photo']);
    expect(cardSlides(card({ release: { title: 'x', type: 'album', latest: false, artworkUrl: null } }))).toEqual(['buy', 'math', 'photo']);
    expect(cardSlides(card({ platform: { id: 'qobuz', name: 'Qobuz', payout: null } }))).toEqual(['buy', 'record', 'photo']);
    expect(cardSlides(card({ imageUrl: null }))).toEqual(['buy', 'record', 'math']);
  });

  it("makes no cards for a name the fonts can't draw, and no record slide for such a title", () => {
    expect(cardSlides(card({ artistName: '坂本龍一' }))).toEqual([]);
    expect(cardSlides(card({ release: { title: 'Мир', type: 'album', latest: true, artworkUrl: 'https://f4.bcbits.com/img/a1_2.jpg' } }))).not.toContain('record');
  });
});

describe('cardFontsCanDraw', () => {
  it('accepts Latin names with accents, punctuation and symbols the fonts carry', () => {
    for (const name of ['Trygve Valøy', 'Das Heinrich Manöver', 'Env!sioN', 'ViệtAnh Nguyễn', 'AC/DC', 'Tom & Jerry “Live”', '$uicideboy$']) {
      expect(cardFontsCanDraw(name)).toBe(true);
    }
  });

  it('refuses scripts and emoji the fonts would draw as nothing', () => {
    for (const name of ['坂本龍一', 'Кино', 'Μάνος', 'فيروز', 'Kid 💡']) {
      expect(cardFontsCanDraw(name)).toBe(false);
    }
  });
});

describe('cardImageUrl', () => {
  it("asks Bandcamp for the 1200px rendition", () => {
    expect(cardImageUrl('https://f4.bcbits.com/img/a1011057568_2.jpg')).toBe('https://f4.bcbits.com/img/a1011057568_10.jpg');
  });

  it("swaps a Mirlo cover's WebP for its JPEG rendition, which the renderer can decode", () => {
    expect(cardImageUrl('https://cdn.mirlo.space/file/trackgroup-covers/652e3aed-7c71-4bc6-9e97-05f67786d7b2-x600.webp?1760780863457'))
      .toBe('https://cdn.mirlo.space/file/trackgroup-covers/652e3aed-7c71-4bc6-9e97-05f67786d7b2-x1500.jpg');
  });

  it('leaves a Mirlo avatar alone, since it has no JPEG rendition', () => {
    const avatar = 'https://cdn.mirlo.space/file/artist-avatars/d3a37de1-fa92-4434-b235-87cb0fc20ac0-x600.webp';
    expect(cardImageUrl(avatar)).toBe(avatar);
  });
});

describe('photoSource', () => {
  it('names the platform a photo came from, and nothing for an unknown host', () => {
    expect(photoSource('https://f4.bcbits.com/img/1_10.jpg')).toBe('Bandcamp');
    expect(photoSource('https://cdn.mirlo.space/file/artist-avatars/x.webp')).toBe('Mirlo');
    expect(photoSource('https://yt3.googleusercontent.com/abc=s900')).toBe('YouTube');
    expect(photoSource('https://images.example.com/me.jpg')).toBeNull();
    expect(photoSource('not a url')).toBeNull();
  });
});

describe('cardAltText', () => {
  it('says what each slide shows, with the registry payout and the low-end math', () => {
    expect(cardAltText('buy', card())).toBe('Kid Lightbulbs, from Boston. Buy their music on Bandcamp, where 80-85% of what you pay goes to the artist.');
    expect(cardAltText('record', card())).toBe('Cover art for any day now by Kid Lightbulbs, their latest album, on Bandcamp.');
    expect(cardAltText('math', card())).toBe("A $10 album on Bandcamp pays Kid Lightbulbs at least $8. At roughly $0.003 a stream, that's around 2,700 streams.");
    expect(cardAltText('photo', card())).toBe('Photo of Kid Lightbulbs, from their Bandcamp page.');
  });

  it("doesn't call a release the latest when nothing dates it", () => {
    const undated = card({ release: { title: 'Signals', type: 'ep', latest: false, artworkUrl: 'https://f4.bcbits.com/img/a1_2.jpg' } });
    expect(cardAltText('record', undated)).toBe('Cover art for Signals by Kid Lightbulbs, on Bandcamp.');
  });
});

describe('socialCardUrl', () => {
  it('carries the platform and release the caption named', () => {
    expect(socialCardUrl('https://unstream.stream', 'kid-lightbulbs', 'record', 'bandcamp', 'any-day-now'))
      .toBe('https://unstream.stream/api/social-card/kid-lightbulbs/record.png?platform=bandcamp&release=any-day-now');
    expect(socialCardUrl('https://unstream.stream', 'kid-lightbulbs', 'buy', 'mirlo', null))
      .toBe('https://unstream.stream/api/social-card/kid-lightbulbs/buy.png?platform=mirlo');
  });
});
