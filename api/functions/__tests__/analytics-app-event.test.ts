// /api/analytics/app-event stores only allowlisted context keys. search_kind and browser
// (2026-10-27) are grouped on by /admin/analytics, so they also have a fixed set of values: a
// stray value would otherwise add a row to the dashboard.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mockInsert: vi.fn() }));

vi.mock('../db', () => ({
  getClient: () => ({ from: () => ({ insert: mocks.mockInsert }) }),
}));
vi.mock('../ratelimit', () => ({
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '203.0.113.7',
}));

import { handler } from '../analytics-app-event';

function post(body: unknown) {
  return handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
}

function storedContext() {
  return mocks.mockInsert.mock.calls[0][0].context;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockInsert.mockResolvedValue({ error: null });
});

describe('context', () => {
  it('keeps search_kind and browser', async () => {
    await post({
      event_type: 'search',
      app: 'extension',
      context: { has_results: true, result_count: 3, search_kind: 'now_playing', browser: 'firefox' },
    });
    expect(storedContext()).toEqual({
      has_results: true,
      result_count: 3,
      search_kind: 'now_playing',
      browser: 'firefox',
    });
  });

  it('drops values outside the fixed sets', async () => {
    await post({
      event_type: 'search',
      app: 'extension',
      context: { search_kind: 'voice', browser: 'safari', has_results: false },
    });
    expect(storedContext()).toEqual({ has_results: false });
  });

  it('drops keys that are not allowlisted', async () => {
    await post({ event_type: 'search', app: 'web', context: { query: 'kid lightbulbs', search_kind: 'typed' } });
    expect(storedContext()).toEqual({ search_kind: 'typed' });
  });
});
