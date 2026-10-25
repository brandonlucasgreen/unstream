// Audit 2026-10-25 #2: "No results found" is reserved for a search where everything answered.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { searchOutcome, platformFailureMessageKey, partialMessageKey } from '../../src/services/searchOutcome';
import { SearchRequestError } from '../../src/services/sources';

const base = { isLoading: false, isEnriching: false, resultCount: 0, failure: null };
const enrichmentFailure = { stage: 'enrichment' as const, messageKey: 'error.searchIncomplete' };

describe('searchOutcome', () => {
  it('is empty only when everything answered with nothing', () => {
    expect(searchOutcome(base)).toBe('empty');
  });

  it('holds the empty state while Phase 2 is still looking', () => {
    expect(searchOutcome({ ...base, isEnriching: true })).toBe('loading');
  });

  it('is failed, not empty, when a part of the search did not answer', () => {
    expect(searchOutcome({ ...base, failure: enrichmentFailure })).toBe('failed');
  });

  it('is partial when cards are on screen but a part failed', () => {
    expect(searchOutcome({ ...base, resultCount: 2, failure: enrichmentFailure })).toBe('partial');
  });

  it('shows results as soon as there are any, even mid-search', () => {
    expect(searchOutcome({ ...base, isLoading: true, resultCount: 1 })).toBe('results');
  });
});

describe('failure messages', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tells a rate-limited fan to wait', () => {
    expect(platformFailureMessageKey(new SearchRequestError('x', 429))).toBe('error.searchRateLimited');
  });

  it('tells an offline fan to reconnect', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(platformFailureMessageKey(new SearchRequestError('x'))).toBe('error.searchOffline');
  });

  it('labels stored-only cards after a platform failure', () => {
    expect(partialMessageKey({ stage: 'platforms', messageKey: 'error.searchFailed' })).toBe('error.searchPartialStored');
  });
});
