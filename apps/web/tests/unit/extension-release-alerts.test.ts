// The browser extension's release-alert rules: dedup, the notification wording, and the window
// it asks the server for.
//
// These are the same rules the Mac app already follows, and the cases below are deliberately the
// same cases apps/mac/UnstreamTests/ReleaseAlertTests.swift pins — Swift can't be driven from
// vitest, so the two suites agreeing on the expected strings is what keeps the clients from
// drifting into saying different things about the same release.
//
// The dedup tests exist because the bug they cover lost data permanently rather than merely
// displaying it wrong: the service worker read the singular `release`, took the newest, and
// marked only that one known. By the next check the newest was already known and nothing looked
// past it, so an artist's second record in the window was unreachable forever.

import { describe, it, expect } from 'vitest';
import {
  formatPlatformList,
  releaseNotificationBody,
  releaseNotificationTitle,
  releaseSummaryLine,
  releasesFromResponse,
  selectUnseenReleases,
  sinceDaysForCheck,
  MIN_SINCE_DAYS,
  MAX_SINCE_DAYS,
} from '../../../../apps/extension/lib/release-alerts.js';

const DAY = 24 * 60 * 60 * 1000;

function result(name: string, overrides: Record<string, unknown> = {}) {
  return {
    releaseName: name,
    releaseDate: '2025-09-01',
    releaseUrl: `https://unstream.stream/a/someone/${name.toLowerCase().replace(/ /g, '-')}`,
    platform: 'bandcamp',
    platforms: ['bandcamp'],
    status: 'released',
    offerSummary: '',
    ...overrides,
  };
}

describe('selectUnseenReleases', () => {
  it('lets a second record through while the first is still unread', () => {
    const known: Record<string, unknown[]> = {};

    const first = selectUnseenReleases([result('First Record')], 'Someone', known);
    expect(first.map(r => r.releaseName)).toEqual(['First Record']);

    // The exact shape of the bug: the newest is already known, so a single-release reader would
    // stop here and never see the second one.
    const second = selectUnseenReleases(
      [result('Second Record'), result('First Record')],
      'Someone',
      known
    );

    expect(second.map(r => r.releaseName)).toEqual(['Second Record']);
  });

  it('takes both when one check reports two new records', () => {
    const known: Record<string, unknown[]> = {};

    const found = selectUnseenReleases([result('A'), result('B')], 'Someone', known);

    expect(found.map(r => r.releaseName)).toEqual(['A', 'B']);
  });

  it('treats one record on two platforms as one alert', () => {
    const known: Record<string, unknown[]> = {};

    const found = selectUnseenReleases(
      [
        result('Infinite Normal', { platform: 'bandcamp' }),
        result('Infinite Normal', { platform: 'mirlo' }),
      ],
      'Kid Lightbulbs',
      known
    );

    expect(found).toHaveLength(1);
  });

  it('scopes known releases to the artist, since two artists can share a title', () => {
    const known: Record<string, unknown[]> = {};
    selectUnseenReleases([result('Greatest Hits')], 'Artist A', known);

    const found = selectUnseenReleases([result('Greatest Hits')], 'Artist B', known);

    expect(found).toHaveLength(1);
  });

  it('matches release names case-insensitively', () => {
    const known: Record<string, unknown[]> = {};
    selectUnseenReleases([result('A Record')], 'Sigur Rós', known);

    const found = selectUnseenReleases([result('a record')], 'sigur rós', known);

    expect(found).toEqual([]);
  });

  it('returns nothing when a re-check reports the same release', () => {
    const known: Record<string, unknown[]> = {};
    selectUnseenReleases([result('A')], 'Someone', known);

    expect(selectUnseenReleases([result('A')], 'Someone', known)).toEqual([]);
  });

  it('persists the platform list, the status and the price summary', () => {
    // These three were dropped by the old code. `offerSummary` in particular was already being
    // read by the popup, where a `||` fallback rendered plausible copy instead of undefined.
    const known: Record<string, unknown[]> = {};

    const found = selectUnseenReleases(
      [
        result('Infinite Normal', {
          platforms: ['bandcamp', 'mirlo'],
          status: 'announced',
          offerSummary: 'from $8 · ≈$6.80 to artist',
        }),
      ],
      'Kid Lightbulbs',
      known
    );

    expect(found[0].platforms).toEqual(['bandcamp', 'mirlo']);
    expect(found[0].status).toBe('announced');
    expect(found[0].offerSummary).toBe('from $8 · ≈$6.80 to artist');
  });

  it('falls back to the leading platform when the server sent no list', () => {
    const known: Record<string, unknown[]> = {};

    const found = selectUnseenReleases(
      [result('A Record', { platforms: undefined, status: undefined, offerSummary: undefined })],
      'Someone',
      known
    );

    expect(found[0].platforms).toEqual(['bandcamp']);
    expect(found[0].status).toBe('released');
    expect(found[0].offerSummary).toBe('');
  });
});

describe('releasesFromResponse', () => {
  it('reads the plural field, which is the one that can hold a second record', () => {
    const response = {
      release: result('Newest'),
      releases: [result('Newest'), result('Older')],
    };

    expect(releasesFromResponse(response).map(r => r.releaseName)).toEqual(['Newest', 'Older']);
  });

  it('falls back to the singular field for an older deploy', () => {
    expect(releasesFromResponse({ release: result('Only One') })).toHaveLength(1);
  });

  it('reports nothing rather than throwing on an empty or missing response', () => {
    expect(releasesFromResponse({ release: null, releases: [] })).toEqual([]);
    expect(releasesFromResponse(null)).toEqual([]);
  });
});

describe('release alert wording', () => {
  function release(overrides: Record<string, unknown> = {}) {
    return {
      artistName: 'Kid Lightbulbs',
      releaseName: 'Infinite Normal',
      releaseDate: '2025-09-01',
      platform: 'bandcamp',
      platforms: ['bandcamp'],
      status: 'released',
      offerSummary: '',
      ...overrides,
    };
  }

  it('names every platform and the price', () => {
    const body = releaseNotificationBody(
      release({ platforms: ['bandcamp', 'mirlo'], offerSummary: 'from $8 · ≈$6.80 to artist' })
    );

    expect(body).toContain('Bandcamp and Mirlo');
    expect(body).toContain('from $8');
    expect(body).toContain('to artist');
  });

  it('omits the price clause rather than inventing one', () => {
    const body = releaseNotificationBody(release());

    expect(body).toBe('"Infinite Normal" — out now on Bandcamp');
    expect(body).not.toContain('·');
  });

  it('reads an announced release as announced, not out now', () => {
    const body = releaseNotificationBody(release({ status: 'announced' }));

    expect(body).toBe('"Infinite Normal" — announced for 1 September on Bandcamp');
    expect(body).not.toContain('out now');
  });

  it('titles an announced release as coming soon', () => {
    expect(releaseNotificationTitle(release({ status: 'announced' }))).toBe(
      'Kid Lightbulbs — coming soon'
    );
    expect(releaseNotificationTitle(release())).toBe('New Release from Kid Lightbulbs');
  });

  it('uses proper platform names rather than capitalizing the id', () => {
    // Plain capitalization renders these "Jamcoop" and "Kofi".
    const body = releaseNotificationBody(release({ platform: 'jamcoop', platforms: ['jamcoop'] }));

    expect(body).toContain('Jam.coop');
    expect(body).not.toContain('Jamcoop');
  });

  it('summarizes a long platform list rather than truncating a name', () => {
    expect(formatPlatformList(['bandcamp', 'mirlo', 'jamcoop', 'discogs'])).toBe(
      'Bandcamp, Mirlo and 2 more'
    );
    expect(formatPlatformList(['bandcamp'])).toBe('Bandcamp');
    expect(formatPlatformList([])).toBe('');
  });

  it('gives the popup the same line as the notification, without the name', () => {
    const r = release({ platforms: ['bandcamp', 'mirlo'], offerSummary: 'Name your price' });

    expect(releaseSummaryLine(r)).toBe('out now on Bandcamp and Mirlo · Name your price');
    expect(releaseNotificationBody(r)).toBe(`"Infinite Normal" — ${releaseSummaryLine(r)}`);
  });

  it('still names the platform on an alert stored by an older build', () => {
    // 2.6.0 kept only `platform`. Those alerts survive the upgrade and must not lose the one
    // piece of platform information they do have.
    expect(releaseSummaryLine(release({ platforms: undefined }))).toBe('out now on Bandcamp');
  });

  it('still says something honest when there is no platform at all', () => {
    expect(releaseSummaryLine(release({ platforms: [], platform: undefined }))).toBe('out now');
  });
});

describe('sinceDaysForCheck', () => {
  const now = Date.UTC(2026, 7, 7);

  it('asks for the whole gap after a long sleep, plus padding', () => {
    // Six weeks closed. Without this the extension took the server's 31-day default and
    // permanently missed everything older than that.
    expect(sinceDaysForCheck(now - 42 * DAY, now)).toBe(49);
  });

  it('never asks for less than the server default', () => {
    expect(sinceDaysForCheck(now - 3 * DAY, now)).toBe(MIN_SINCE_DAYS);
  });

  it('never asks for more than the server accepts', () => {
    expect(sinceDaysForCheck(now - 900 * DAY, now)).toBe(MAX_SINCE_DAYS);
  });

  it('falls back to the default on a first run or a nonsense timestamp', () => {
    expect(sinceDaysForCheck(undefined, now)).toBe(MIN_SINCE_DAYS);
    expect(sinceDaysForCheck(now + 5 * DAY, now)).toBe(MIN_SINCE_DAYS);
  });
});
