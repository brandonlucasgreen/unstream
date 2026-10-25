// Audit 2026-10-25 #4: a release check that couldn't reach the server used to be recorded as a
// successful "No new releases" check, and moved lastCheckDate forward — so the next check asked
// for a narrower window and a release in the gap was missed for good.
//
// Same harness as extension-release-check.test.ts: the real service worker under a stubbed
// chrome.*, driven by CHECK_RELEASES_NOW.

import { describe, it, expect, beforeAll, vi } from 'vitest';

type MessageHandler = (
  message: { type: string },
  sender: unknown,
  sendResponse: (value: unknown) => void
) => unknown;

type CheckResult = {
  checked: boolean;
  newCount: number;
  outcome: { status: string; total: number; failedCount: number; uncheckableCount: number };
};
type CheckState = {
  lastCheckDate: number;
  artistLastChecked?: Record<string, number>;
  lastCheckOutcome?: { status: string };
};

const storage: Record<string, unknown> = {};
const requests: { artistName: string; sinceDays: number }[] = [];
const FORTY_TWO_DAYS_AGO = Date.now() - 42 * 24 * 60 * 60 * 1000;
let downIsOffline = false;
let downStatus = 503;
let messageHandler: MessageHandler;

function runCheck(): Promise<CheckResult> {
  return new Promise(resolve => {
    messageHandler({ type: 'CHECK_RELEASES_NOW' }, {}, value => resolve(value as CheckResult));
  });
}

const state = () => storage.releaseCheckState as CheckState;

let first: CheckResult;
let second: CheckResult;
let third: CheckResult;

beforeAll(async () => {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };

  storage.savedArtistsData = {
    Up: { platforms: [{ sourceId: 'bandcamp', url: 'https://up.bandcamp.com' }] },
    Down: { platforms: [{ sourceId: 'bandcamp', url: 'https://down.bandcamp.com' }] },
    'Never Catalogued': { platforms: [] },
  };
  storage.releaseCheckState = { lastCheckDate: FORTY_TWO_DAYS_AGO, knownReleases: {}, newReleases: [] };

  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      onMessage: { addListener: (handler: MessageHandler) => { messageHandler = handler; } },
      onInstalled: listener,
      onStartup: listener,
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    alarms: { onAlarm: listener, clear: async () => {}, create: async () => {} },
    storage: {
      local: {
        get: async (key: string | null) => {
          if (key === null) return { ...storage };
          return key in storage ? { [key]: storage[key] } : {};
        },
        set: async (values: Record<string, unknown>) => Object.assign(storage, values),
        remove: async () => {},
      },
      sync: { get: async () => ({}) },
    },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    notifications: { create: async () => {}, onClicked: listener },
    tabs: { create: async () => {} },
    permissions: { onRemoved: listener, getAll: async () => ({ origins: [] }) },
    scripting: { getRegisteredContentScripts: async () => [] },
  };

  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (!String(url).includes('/check-releases')) return { ok: true, json: async () => ({}) };
    const body = JSON.parse(init?.body || '{}');
    requests.push(body);
    if (body.artistName === 'Down') {
      if (downIsOffline) throw new TypeError('Failed to fetch');
      return { ok: false, status: downStatus, json: async () => ({}) };
    }
    if (body.artistName === 'Never Catalogued') {
      // The server has nothing to check for this artist yet: not checked, but not a failure.
      return { ok: false, status: 400, json: async () => ({ error: 'no platform' }) };
    }
    return { ok: true, json: async () => ({ artistName: body.artistName, releases: [] }) };
  });

  await import('../../../../apps/extension/background/service-worker.js');

  first = await runCheck();
  downIsOffline = true;
  requests.length = 0;
  second = await runCheck();
  // A Cloudflare bot challenge answers 403. It must count as a failure, not as "checked".
  downIsOffline = false;
  downStatus = 403;
  third = await runCheck();
});

describe('a check where one artist could not be reached', () => {
  it('reports a partial check, not "no new releases"', () => {
    expect(first.outcome).toMatchObject({ status: 'partial', total: 3, failedCount: 1, uncheckableCount: 1 });
  });

  it('does not move the check-wide date forward', () => {
    expect(state().lastCheckDate).toBe(FORTY_TWO_DAYS_AGO);
  });

  it('records a successful check only for the artist that was really checked', () => {
    // Not 'Never Catalogued': a 400 means it wasn't checked, so its window must not narrow.
    expect(Object.keys(state().artistLastChecked ?? {})).toEqual(['Up']);
  });

  it('asks the next check for the whole missed window for the artist that failed', () => {
    const down = requests.find(r => r.artistName === 'Down')!;
    const up = requests.find(r => r.artistName === 'Up')!;
    expect(down.sinceDays).toBe(50);
    expect(up.sinceDays).toBe(31);
  });

  it('treats a network error the same way, and keeps the outcome for the popup', () => {
    expect(second.outcome.status).toBe('partial');
  });

  it('counts a 403 bot challenge as a failure, never as checked', () => {
    expect(third.outcome).toMatchObject({ status: 'partial', failedCount: 1 });
    expect(state().artistLastChecked?.Down).toBeUndefined();
    expect(state().lastCheckDate).toBe(FORTY_TWO_DAYS_AGO);
    expect(state().lastCheckOutcome?.status).toBe('partial');
  });
});
