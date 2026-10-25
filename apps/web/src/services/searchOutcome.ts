import { SearchRequestError } from './sources';

// What the search page is showing, decided in one place. Before this, a failed search
// turned into an empty result list, so an offline or rate-limited fan read "No results
// found" — a claim that the artist isn't here — and the empty state could also appear
// after Phase 1 while Phase 2 was still looking.
//
// - loading  — nothing to show yet, and something is still running (Phase 2 included).
// - results  — every search that ran answered.
// - partial  — cards to show, but some part of the search didn't answer.
// - empty    — every search answered and found nothing. The only state that may say
//              "No results found".
// - failed   — nothing to show, and some part of the search didn't answer.

export type SearchOutcome = 'loading' | 'results' | 'partial' | 'empty' | 'failed';

/** Which part of a search didn't answer. */
export type SearchFailureStage =
  | 'platforms'      // Phase 1 failed outright; any cards on screen are the stored preview
  | 'some-queries'   // a multi-artist search where some of the split queries failed
  | 'enrichment';    // Phase 2 (MusicBrainz) failed

export interface SearchFailure {
  stage: SearchFailureStage;
  /** The i18n key (common namespace) explaining the failure to the fan. */
  messageKey: string;
}

export function searchOutcome(state: {
  isLoading: boolean;
  isEnriching: boolean;
  resultCount: number;
  failure: SearchFailure | null;
}): SearchOutcome {
  const { isLoading, isEnriching, resultCount, failure } = state;
  if (resultCount === 0) {
    if (isLoading || isEnriching) return 'loading';
    return failure ? 'failed' : 'empty';
  }
  return failure ? 'partial' : 'results';
}

/** Why a Phase 1 request failed, as an i18n key: offline, rate-limited, or anything else. */
export function platformFailureMessageKey(error: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'error.searchOffline';
  if (error instanceof SearchRequestError && error.status === 429) return 'error.searchRateLimited';
  return 'error.searchFailed';
}

/**
 * The message for a search with cards on screen but a part that failed. Phase 1 failing
 * leaves only the stored preview, which is worth saying plainly: those are the artists
 * Unstream already knew, not the result of searching the platforms.
 */
export function partialMessageKey(failure: SearchFailure): string {
  switch (failure.stage) {
    case 'platforms': return 'error.searchPartialStored';
    case 'some-queries': return 'error.searchPartial';
    case 'enrichment': return 'error.enrichmentFailed';
  }
}
