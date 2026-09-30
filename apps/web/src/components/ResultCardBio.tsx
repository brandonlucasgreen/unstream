import { useLayoutEffect, useRef, useState } from 'react';
import type { ArtistBio } from '../types';

// Names the platform, except for a claimed artist's own words (decided 2026-09-30).
// Wikipedia's text is CC BY-SA, which asks for the licence alongside the attribution.
const SOURCE_LABELS: Record<ArtistBio['source'], string> = {
  unstream: 'From the artist',
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
 * The artist's bio, clamped to three lines with an inline "More", and always a link to where it
 * came from. The server picked it (api/shared/artist-bio.ts); this only draws it, as text.
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
      <div className="flex gap-3 text-xs">
        {(clamped || expanded) && (
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
        {isWebUrl(bio.sourceUrl) && (
          <a
            href={bio.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-muted hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {SOURCE_LABELS[bio.source] ?? 'Source'}
            {bio.truncated ? ' · Read more' : ''} ↗
          </a>
        )}
      </div>
    </div>
  );
}
