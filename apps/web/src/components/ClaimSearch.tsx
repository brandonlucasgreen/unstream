import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { fetchStoredArtists, searchArtistsToClaim, SearchRequestError } from '../services/sources';
import { claimRows, type ClaimRow } from './ClaimSearchUtils';

type Status = 'idle' | 'searching' | 'done' | 'failed' | 'rate-limited';

export const CLAIM_SEARCH_INPUT_ID = 'claim-search-input';

/**
 * "Find your page" on /for-artists: the same two requests as the homepage search (stored
 * artists first, then the full Phase 1 fan-out), shown as one row per artist with a Claim
 * button instead of a full result card. The claim flow itself is untouched; this only gets an
 * artist to /claim/:slug without having to read a fan's results page first.
 */
export function ClaimSearch() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  // A newer search makes an older one's late answers irrelevant.
  const currentSearch = useRef(0);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    const searchId = ++currentSearch.current;
    setRows([]);
    setStatus('searching');

    let fullResultsArrived = false;
    fetchStoredArtists(trimmed).then(stored => {
      if (currentSearch.current !== searchId || fullResultsArrived) return;
      const storedRows = claimRows(stored);
      if (storedRows.length > 0) setRows(storedRows);
    });

    try {
      const response = await searchArtistsToClaim(trimmed);
      if (currentSearch.current !== searchId) return;
      fullResultsArrived = true;
      const fullRows = claimRows(response.results);
      // Same guard as the homepage: never swap artists we know exist for "not found".
      setRows(prev => (fullRows.length === 0 && prev.length > 0 ? prev : fullRows));
      setStatus('done');
    } catch (error) {
      // searchArtistsToClaim has already reported anything worth reporting to Sentry.
      if (currentSearch.current !== searchId) return;
      setStatus(error instanceof SearchRequestError && error.status === 429 ? 'rate-limited' : 'failed');
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex gap-2" role="search">
        <label htmlFor={CLAIM_SEARCH_INPUT_ID} className="sr-only">Your artist name</label>
        <input
          id={CLAIM_SEARCH_INPUT_ID}
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Your artist name"
          autoComplete="off"
          className="search-input flex-1 min-w-0"
        />
        <button
          type="submit"
          disabled={status === 'searching'}
          className="px-4 py-3 rounded-lg bg-accent-primary text-accent-foreground font-semibold whitespace-nowrap hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          Find my page
        </button>
      </form>

      <div aria-live="polite" className="mt-3 space-y-2">
        {rows.map(row => <ClaimRowItem key={row.id} row={row} />)}

        {status === 'searching' && (
          <p className="text-sm text-text-muted">
            {rows.length > 0 ? 'Still checking the other platforms…' : 'Searching every platform. This takes a few seconds…'}
          </p>
        )}
        {status === 'done' && rows.length === 0 && (
          <p className="text-sm text-text-secondary">
            No page for that name yet. Unstream finds artists on Bandcamp, Mirlo, Ampwall, Faircamp and more, so if
            you sell your music somewhere, <Link to="/contact" className="text-link hover:underline">tell me where</Link> and
            I’ll take a look.
          </p>
        )}
        {status === 'failed' && (
          <p className="text-sm text-error" role="alert">The search didn’t finish. Please try again.</p>
        )}
        {status === 'rate-limited' && (
          <p className="text-sm text-error" role="alert">That’s a lot of searches in a row. Try again in a minute.</p>
        )}
      </div>
    </div>
  );
}

function ClaimRowItem({ row }: { row: ClaimRow }) {
  const details = [row.location, row.platformNames.join(', ')].filter(Boolean).join(' · ');

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-card p-3">
      {row.imageUrl ? (
        <img src={row.imageUrl} alt="" className="w-11 h-11 rounded-lg object-cover shrink-0" loading="lazy" />
      ) : (
        <div className="w-11 h-11 rounded-lg bg-bg-hover shrink-0" aria-hidden="true" />
      )}
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-text-primary truncate">{row.name}</p>
        {details && <p className="text-xs text-text-muted truncate">{details}</p>}
      </div>
      {row.action.kind === 'claim' ? (
        <Link
          to={row.action.href}
          className="shrink-0 px-3 py-2 rounded-lg bg-accent-primary text-accent-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          Claim this page
        </Link>
      ) : (
        <Link to={row.action.href} className="shrink-0 text-sm font-semibold text-success hover:underline">
          ✓ Claimed
        </Link>
      )}
    </div>
  );
}
