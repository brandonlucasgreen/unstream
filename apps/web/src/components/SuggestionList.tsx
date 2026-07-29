import type { ArtistSuggestion } from '../hooks/useArtistSuggestions';

/**
 * The typeahead dropdown, shared by the header search and the SearchBar so the
 * ARIA wiring lives in one place.
 *
 * `idPrefix` is load-bearing: in PWA mode the homepage renders both inputs at
 * once (the header's, plus the app home's prominent SearchBar), and a hardcoded
 * id would give that page two elements called `search-suggestions`, pointing
 * every `aria-activedescendant` at whichever one rendered first.
 */
export function SuggestionList({
  idPrefix,
  suggestions,
  highlightIndex,
  onHighlight,
  onPick,
}: {
  idPrefix: string;
  suggestions: ArtistSuggestion[];
  highlightIndex: number;
  onHighlight: (index: number) => void;
  onPick: (suggestion: ArtistSuggestion) => void;
}) {
  return (
    <ul
      id={`${idPrefix}-suggestions`}
      role="listbox"
      className="absolute z-20 mt-1 w-full rounded border border-border bg-bg-primary shadow-lg overflow-hidden"
    >
      {suggestions.map((suggestion, index) => (
        <li
          key={suggestion.slug}
          id={`${idPrefix}-suggestion-${index}`}
          role="option"
          aria-selected={index === highlightIndex}
          // onMouseDown so the pick lands before the input's onBlur closes the list
          onMouseDown={(e) => { e.preventDefault(); onPick(suggestion); }}
          onMouseEnter={() => onHighlight(index)}
          className={`px-4 py-2 cursor-pointer text-left text-text-primary ${index === highlightIndex ? 'bg-bg-secondary' : ''}`}
        >
          {suggestion.name}
        </li>
      ))}
    </ul>
  );
}
