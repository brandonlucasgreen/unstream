// The extension's copy of the Bandcamp identity rule must answer exactly as the shared one does.
//
// api/shared/bandcamp-identity.ts is the source of truth (backend and web import it). The
// extension ships plain JS and keeps a copy in apps/extension/lib/bandcamp-identity.js; the Mac
// app's Swift copy is pinned by BandcampIdentityTests.swift with the same cases. A copy that
// drifted would bring back the Honeycrush (Brooklyn) / Honey Crush (Orlando) merge in one client.

import { describe, it, expect } from 'vitest';
import * as shared from '../../../../api/shared/bandcamp-identity';
import * as extension from '../../../../apps/extension/lib/bandcamp-identity.js';

const URLS = [
  'https://honeycrush.bandcamp.com/',
  'https://HoneyCrush.bandcamp.com/music',
  'https://honeycrush-online.bandcamp.com/album/x',
  'https://bandcamp.com/search?q=honeycrush',
  'https://honeycrushing.com/',
  'not a url',
  '',
  null,
  undefined,
];

const MB_SUBDOMAINS = ['honeyyycrush', 'honeycrush', 'HoneyCrush', '', null, undefined];

describe('extension copy of bandcamp-identity', () => {
  it('reads every URL the same way', () => {
    for (const url of URLS) {
      expect(extension.bandcampSubdomainOf(url), String(url)).toBe(shared.bandcampSubdomainOf(url));
    }
  });

  it('calls the same pairs conflicting', () => {
    for (const mb of MB_SUBDOMAINS) {
      for (const url of URLS) {
        expect(extension.bandcampSubdomainConflicts(mb, url), `${mb} vs ${url}`)
          .toBe(shared.bandcampSubdomainConflicts(mb, url));
      }
    }
  });
});

describe('enrichmentIsAnotherArtist (extension popup)', () => {
  const orlando = [{ type: 'artist', name: 'Honey Crush', platforms: [{ sourceId: 'bandcamp', url: 'https://honeycrush.bandcamp.com/' }] }];

  it("refuses Brooklyn's enrichment under Orlando's Bandcamp link", () => {
    expect(extension.enrichmentIsAnotherArtist(orlando, { artistName: 'Honeycrush', bandcampSubdomain: 'honeyyycrush' })).toBe(true);
  });

  it('accepts enrichment for the account on screen', () => {
    expect(extension.enrichmentIsAnotherArtist(orlando, { artistName: 'Honey Crush', bandcampSubdomain: 'honeycrush' })).toBe(false);
  });

  it('accepts enrichment from an older deploy that sends no subdomain, or with no Bandcamp shown', () => {
    expect(extension.enrichmentIsAnotherArtist(orlando, { artistName: 'Honeycrush' })).toBe(false);
    expect(extension.enrichmentIsAnotherArtist([{ type: 'artist', name: 'Honeycrush', platforms: [] }], { bandcampSubdomain: 'honeyyycrush' })).toBe(false);
    expect(extension.enrichmentIsAnotherArtist(null, null)).toBe(false);
  });

  it('checks the first Bandcamp link, the one the popup shows', () => {
    const results = [
      ...orlando,
      { type: 'artist', name: 'Honeycrush', platforms: [{ sourceId: 'bandcamp', url: 'https://honeyyycrush.bandcamp.com/' }] },
    ];
    expect(extension.enrichmentIsAnotherArtist(results, { bandcampSubdomain: 'honeyyycrush' })).toBe(true);
  });
});
