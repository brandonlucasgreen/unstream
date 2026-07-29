import { useState, useCallback, useEffect, useRef } from 'react';

interface SearchBarProps {
  onSearch: (query: string) => void;
  isLoading: boolean;
  initialQuery?: string;
  onReset?: () => void;
}

interface Suggestion {
  slug: string;
  name: string;
  imageUrl: string | null;
}

const SUGGEST_DEBOUNCE_MS = 250;
const SUGGEST_MIN_CHARS = 2;

export function SearchBar({ onSearch, isLoading, initialQuery, onReset }: SearchBarProps) {
  const [query, setQuery] = useState(initialQuery || '');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  // Update query when initialQuery changes (for URL resolution or reset)
  useEffect(() => {
    setQuery(initialQuery || '');
  }, [initialQuery]);

  const closeSuggestions = useCallback(() => {
    setShowSuggestions(false);
    setHighlightIndex(-1);
  }, []);

  const submitSearch = useCallback((term: string) => {
    closeSuggestions();
    clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    if (term.trim()) {
      onSearch(term.trim());
    }
  }, [onSearch, closeSuggestions]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    submitSearch(query);
  }, [query, submitSearch]);

  const handleChange = useCallback((value: string) => {
    setQuery(value);
    setHighlightIndex(-1);
    clearTimeout(debounceRef.current);

    const term = value.trim();
    if (term.length < SUGGEST_MIN_CHARS) {
      abortRef.current?.abort();
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(`/api/suggest?query=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json() as { suggestions?: Suggestion[] };
        const next = data.suggestions || [];
        setSuggestions(next);
        setShowSuggestions(next.length > 0);
      } catch {
        // Aborted or network hiccup — typeahead is best-effort, the real
        // search happens on submit.
      }
    }, SUGGEST_DEBOUNCE_MS);
  }, []);

  const pickSuggestion = useCallback((suggestion: Suggestion) => {
    setQuery(suggestion.name);
    submitSearch(suggestion.name);
  }, [submitSearch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(i => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault();
      pickSuggestion(suggestions[highlightIndex]);
    } else if (e.key === 'Escape') {
      closeSuggestions();
    }
  }, [showSuggestions, suggestions, highlightIndex, pickSuggestion, closeSuggestions]);

  const handleReset = useCallback(() => {
    // Cancel any pending debounce/fetch — a stale response landing after the
    // reset would reopen the dropdown against an empty input.
    clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setQuery('');
    setSuggestions([]);
    closeSuggestions();
    inputRef.current?.focus();
    onReset?.();
  }, [onReset, closeSuggestions]);

  // Cancel any in-flight suggestion work on unmount
  useEffect(() => () => {
    clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl mx-auto">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (suggestions.length > 0 && query.trim().length >= SUGGEST_MIN_CHARS) setShowSuggestions(true); }}
            onBlur={closeSuggestions}
            placeholder="Search for artists..."
            className="search-input w-full pr-16"
            disabled={isLoading}
            role="combobox"
            aria-expanded={showSuggestions}
            aria-controls="search-suggestions"
            aria-activedescendant={highlightIndex >= 0 ? `search-suggestion-${highlightIndex}` : undefined}
            aria-autocomplete="list"
          />
          {onReset && (
            <button
              type="button"
              onClick={handleReset}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-text-muted hover:text-text-secondary transition-colors"
            >
              Reset
            </button>
          )}
          {showSuggestions && (
            <ul
              id="search-suggestions"
              role="listbox"
              className="absolute z-20 mt-1 w-full rounded border border-border bg-bg-primary shadow-lg overflow-hidden"
            >
              {suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.slug}
                  id={`search-suggestion-${index}`}
                  role="option"
                  aria-selected={index === highlightIndex}
                  // onMouseDown so the pick lands before the input's onBlur closes the list
                  onMouseDown={(e) => { e.preventDefault(); pickSuggestion(suggestion); }}
                  onMouseEnter={() => setHighlightIndex(index)}
                  className={`px-4 py-2 cursor-pointer text-left ${index === highlightIndex ? 'bg-bg-secondary' : ''}`}
                >
                  {suggestion.name}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="submit"
          disabled={isLoading || !query.trim()}
          className="px-4 py-3 bg-accent-primary text-bg-primary font-medium rounded hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-2"
        >
            {isLoading ? (
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
            Search
          </button>
      </div>
    </form>
  );
}
