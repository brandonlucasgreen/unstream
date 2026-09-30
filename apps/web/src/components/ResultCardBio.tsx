import { useLayoutEffect, useRef, useState } from 'react';
import type { ArtistBio } from '../types';

// Names the platform the bio came from. A claimed artist's own bio ('unstream') gets no source
// line: the card's "View artist page" already goes to the same page (decided 2026-09-30).
// Wikipedia's text is CC BY-SA, which asks for the licence alongside the attribution.
const SOURCE_LABELS: Record<Exclude<ArtistBio['source'], 'unstream'>, string> = {
  bandcamp: 'From Bandcamp',
  discogs: 'From Discogs',
  wikipedia: 'From Wikipedia · CC BY-SA',
};

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

interface ResultCardBioProps {
  bio: ArtistBio;
}

/**
 * The artist's bio, clamped to three lines with an inline "More", and a link to where it came
 * from unless that's the artist's own Unstream page. The server picked it
 * (api/shared/artist-bio.ts); this only draws it, as text.
 */
export function ResultCardBio({ bio }: ResultCardBioProps) {
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  // "More" only when the clamp is actually hiding something — measured, since a character count
  // would be wrong at every other width.
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bio.text, expanded]);

  const sourceLabel =
    bio.source !== 'unstream' && isWebUrl(bio.sourceUrl) ? (SOURCE_LABELS[bio.source] ?? 'Source') : null;
  const showToggle = clamped || expanded;

  return (
    <div className="space-y-1">
      <div
        ref={textRef}
        className={`text-sm text-text-secondary leading-relaxed space-y-2 ${expanded ? '' : 'line-clamp-3'}`}
      >
        {bio.text.split('\n\n').map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
      {(showToggle || sourceLabel) && (
        <div className="flex gap-3 text-xs">
          {showToggle && (
            <button
              type="button"
              className="text-accent-primary hover:underline"
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
            >
              {expanded ? 'Less' : 'More'}
            </button>
          )}
          {sourceLabel && (
            <a
              href={bio.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-muted hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {sourceLabel}
              {bio.truncated ? ' · Read more' : ''} ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
