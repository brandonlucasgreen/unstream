import { useCallback, useEffect, useRef, useState } from 'react';

export interface ArtistSuggestion {
  slug: string;
  name: string;
  imageUrl: string | null;
}

const SUGGEST_DEBOUNCE_MS = 250;
const SUGGEST_MIN_CHARS = 2;

/**
 * Typeahead against /api/suggest, shared by the header search and the larger
 * SearchBar. It owns the debounce, the in-flight abort, and the keyboard
 * highlight so the two inputs can't drift apart on behaviour or accessibility.
 *
 * The caller keeps its own input value and decides what picking a suggestion
 * means (searching in place vs navigating), which is the only thing that
 * actually differs between the two.
 */
export function useArtistSuggestions(onPick: (name: string) => void) {
  const [suggestions, setSuggestions] = useState<ArtistSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const close = useCallback(() => {
    setIsOpen(false);
    setHighlightIndex(-1);
  }, []);

  /** Drop any pending debounce and in-flight request. */
  const cancel = useCallback(() => {
    clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  /** Cancel outstanding work and empty the list — for a reset or a submit. */
  const clear = useCallback(() => {
    cancel();
    setSuggestions([]);
    close();
  }, [cancel, close]);

  /** Call on every keystroke with the raw input value. */
  const query = useCallback((value: string) => {
    setHighlightIndex(-1);
    clearTimeout(debounceRef.current);

    const term = value.trim();
    if (term.length < SUGGEST_MIN_CHARS) {
      abortRef.current?.abort();
      setSuggestions([]);
      setIsOpen(false);
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
        const data = await response.json() as { suggestions?: ArtistSuggestion[] };
        const next = data.suggestions || [];
        setSuggestions(next);
        setIsOpen(next.length > 0);
      } catch {
        // Aborted or network hiccup — typeahead is best-effort, the real
        // search happens on submit.
      }
    }, SUGGEST_DEBOUNCE_MS);
  }, []);

  const pick = useCallback((suggestion: ArtistSuggestion) => {
    cancel();
    close();
    onPick(suggestion.name);
  }, [cancel, close, onPick]);

  /** Reopen the list on focus, if there's still something worth showing. */
  const reopen = useCallback((value: string) => {
    if (suggestions.length > 0 && value.trim().length >= SUGGEST_MIN_CHARS) {
      setIsOpen(true);
    }
  }, [suggestions]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(i => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault();
      pick(suggestions[highlightIndex]);
    } else if (e.key === 'Escape') {
      close();
    }
  }, [isOpen, suggestions, highlightIndex, pick, close]);

  // Cancel any in-flight suggestion work on unmount
  useEffect(() => () => {
    clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  return {
    suggestions,
    isOpen,
    highlightIndex,
    setHighlightIndex,
    query,
    pick,
    close,
    clear,
    cancel,
    reopen,
    handleKeyDown,
  };
}
