import { describe, it, expect } from 'vitest';

// The bug this guards: the Foo Fighters artist page read "Seattle, California".
//
// Two independent defects combined to produce it, both confirmed against the live
// MusicBrainz API and the production `artists` table on 2026-08-09.
//
// 1. Area classification read `type`, which MusicBrainz leaves null on almost all
//    community-entered areas. Foo Fighters' area is "United States" with `type: null`,
//    so the old code filed the country as a *city*. Across 244 rows carrying a location
//    that produced "United States", "Germany", "France", "Poland" and "Michigan" sitting
//    in the city column.
//
// 2. Locations were assembled field by field across sources. MusicBrainz supplied the
//    city (Seattle, their begin-area) and left `country` empty; foofighters.bandcamp.com
//    says "California", which filled that empty slot. Each source was right on its own;
//    the combination named a place that does not exist. The same merge produced
//    "Brooklyn, Florida", "Omaha, Colorado", "Basel, New York", "Issaquah, Oregon",
//    "Düsseldorf, Russia" and "Limerick, UK".
//
// The area fixtures below are the real API payloads, trimmed to the fields we read.

import { parseMusicBrainzArea, pickLocation, parseLocationString } from '../../search/enrichment';

// GET /ws/2/artist/67f66c07-6e61-4026-ade5-7e782fad3a5d?fmt=json
const FOO_FIGHTERS_AREA = {
  name: 'United States',
  type: null,
  'iso-3166-1-codes': ['US'],
};
const FOO_FIGHTERS_BEGIN_AREA = {
  name: 'Seattle',
  type: null,
};

// GET /ws/2/artist/bd743cdc-74a1-4669-bcf9-3942594dc09a?fmt=json
const CITIZEN_BEGIN_AREA = {
  name: 'Michigan',
  type: null,
  'iso-3166-2-codes': ['US-MI'],
};

describe('parseMusicBrainzArea', () => {
  it('reads a null-type area with an ISO 3166-1 code as a country, not a city', () => {
    const location = parseMusicBrainzArea(FOO_FIGHTERS_AREA, undefined, 'US');

    expect(location).toEqual({ country: 'United States', countryCode: 'US' });
    expect(location?.city).toBeUndefined();
  });

  it('puts the begin-area city beside its country', () => {
    const location = parseMusicBrainzArea(FOO_FIGHTERS_AREA, FOO_FIGHTERS_BEGIN_AREA, 'US');

    expect(location).toEqual({ city: 'Seattle', country: 'United States', countryCode: 'US' });
  });

  it('reads a null-type area with an ISO 3166-2 code as a subdivision', () => {
    const location = parseMusicBrainzArea(FOO_FIGHTERS_AREA, CITIZEN_BEGIN_AREA, 'US');

    // No city on offer, so the subdivision takes the specific slot.
    expect(location).toEqual({ city: 'Michigan', country: 'United States', countryCode: 'US' });
  });

  it('prefers a subdivision over the country beside a known city', () => {
    const location = parseMusicBrainzArea(
      CITIZEN_BEGIN_AREA,
      { name: 'Detroit', type: null },
      'US',
    );

    expect(location).toEqual({ city: 'Detroit', country: 'Michigan', countryCode: 'US' });
  });

  it('still honours an explicit Country type when ISO codes are absent', () => {
    const location = parseMusicBrainzArea({ name: 'Japan', type: 'Country' }, undefined, 'JP');

    expect(location).toEqual({ country: 'Japan', countryCode: 'JP' });
  });

  it('names the country when only the top-level code identifies it', () => {
    // MusicBrainz files Destroy Boys under area "Sacramento" with country "US" and no
    // country area, which used to render as "Sacramento, US".
    const location = parseMusicBrainzArea({ name: 'Sacramento', type: null }, undefined, 'US');

    expect(location).toEqual({ city: 'Sacramento', country: 'United States', countryCode: 'US' });
  });

  it('falls back to the top-level country code when there is no area at all', () => {
    expect(parseMusicBrainzArea(undefined, undefined, 'FR')).toEqual({
      country: 'France',
      countryCode: 'FR',
    });
    expect(parseMusicBrainzArea(undefined, undefined, undefined)).toBeUndefined();
  });

  it('leaves an unrecognised country code unnamed rather than inventing one', () => {
    expect(parseMusicBrainzArea(undefined, undefined, 'XW')).toEqual({ countryCode: 'XW' });
  });
});

describe('pickLocation', () => {
  it('does not fill an empty region slot from a second source', () => {
    // A source that knows only a city is not topped up from one that knows only a region.
    const musicbrainz = { city: 'Seattle', countryCode: 'US' };
    const bandcamp = parseLocationString('California');

    expect(pickLocation(musicbrainz, bandcamp, null)).toEqual(musicbrainz);
  });

  it('reproduces the Foo Fighters page end to end', () => {
    const musicbrainz = parseMusicBrainzArea(FOO_FIGHTERS_AREA, FOO_FIGHTERS_BEGIN_AREA, 'US');
    // foofighters.bandcamp.com's location field, verbatim.
    const bandcamp = parseLocationString('California');

    const location = pickLocation(musicbrainz, bandcamp);
    const displayed = [location?.city, location?.country ?? location?.countryCode]
      .filter(Boolean)
      .join(', ');

    expect(displayed).toBe('Seattle, United States');
  });

  it('takes the whole of the most specific source that answered', () => {
    const musicbrainz = { countryCode: 'US' };
    const bandcamp = parseLocationString('Portland, Oregon');

    expect(pickLocation(musicbrainz, bandcamp)).toEqual({ city: 'Portland', country: 'Oregon' });
  });

  it('prefers a country-only source over a bare country code', () => {
    expect(pickLocation({ countryCode: 'DE' }, { country: 'Germany' })).toEqual({ country: 'Germany' });
  });

  it('ignores sources that did not answer', () => {
    expect(pickLocation(null, undefined, {}, { city: 'Bristol' })).toEqual({ city: 'Bristol' });
    expect(pickLocation(null, undefined, {})).toBeUndefined();
  });
});
