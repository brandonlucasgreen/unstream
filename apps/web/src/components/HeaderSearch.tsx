import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useArtistSuggestions } from '../hooks/useArtistSuggestions';
import { SuggestionList } from './SuggestionList';

/**
 * The persistent search input in the site header.
 *
 * Submitting navigates to /?q=… rather than rendering results in place. The
 * homepage is the app's only search renderer, and /search already belongs to
 * the noscript-search edge function — pointing a second renderer at that URL is
 * the bifurcation trap in docs/retros/UNS-100-bifurcation-retro.md.
 *
 * The input value stays inside this component on purpose. Lifting it into
 * Header (or a context) would re-render whichever page is mounted on every
 * keystroke, since every page renders its own Header.
 */
export function HeaderSearch({
  autoFocus,
  onClose,
}: {
  autoFocus?: boolean;
  /** Called after a search is submitted, or on Escape — closes the mobile row. */
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);

  // Follow the URL, so the input shows what the page is actually searching for:
  // a shared /?q= link, a resolved ?url= link, and the back button. Keyed on the
  // query string rather than the params object so an unrelated param change
  // can't wipe out what someone is mid-way through typing.
  useEffect(() => {
    setQuery(urlQuery);
  }, [urlQuery]);

  const runSearch = useCallback((term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    navigate(`/?q=${encodeURIComponent(trimmed)}`);
    onClose?.();
  }, [navigate, onClose]);

  const handlePick = useCallback((name: string) => {
    setQuery(name);
    runSearch(name);
  }, [runSearch]);

  const suggest = useArtistSuggestions(handlePick);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    suggest.clear();
    runSearch(query);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    suggest.handleKeyDown(e);
    // Escape closes the dropdown first; a second press dismisses the mobile row.
    if (e.key === 'Escape' && !suggest.isOpen) onClose?.();
  }

  return (
    <form onSubmit={handleSubmit} role="search" className="relative w-full">
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); suggest.query(e.target.value); }}
        onKeyDown={handleKeyDown}
        onFocus={() => suggest.reopen(query)}
        onBlur={suggest.close}
        placeholder="Search artists..."
        aria-label="Search artists"
        enterKeyHint="search"
        autoFocus={autoFocus}
        // text-base (16px) below lg: iOS Safari zooms in on focus for any input
        // under 16px, which also breaks the page's responsive width until the
        // user manually zooms back out. Desktop keeps text-sm to match the nav.
        className={
          'w-full bg-bg-secondary border border-border rounded-lg pl-9 pr-3 py-2 ' +
          'text-base lg:text-sm text-text-primary placeholder-text-muted ' +
          'focus:outline-none focus:border-accent-primary transition-colors'
        }
        role="combobox"
        aria-expanded={suggest.isOpen}
        aria-controls="header-search-suggestions"
        aria-activedescendant={suggest.highlightIndex >= 0 ? `header-search-suggestion-${suggest.highlightIndex}` : undefined}
        aria-autocomplete="list"
      />
      {suggest.isOpen && (
        <SuggestionList
          idPrefix="header-search"
          suggestions={suggest.suggestions}
          highlightIndex={suggest.highlightIndex}
          onHighlight={suggest.setHighlightIndex}
          onPick={suggest.pick}
        />
      )}
    </form>
  );
}
