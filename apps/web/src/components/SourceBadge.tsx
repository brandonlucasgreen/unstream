import type { Source } from '../types';
import { analytics } from '../services/analytics';
import { isBandcampFriday } from '../utils/bandcamp-friday';
import { PlatformIcon } from './PlatformIcon';

interface SourceBadgeProps {
  source: Source;
  url: string;
  isDirectLink?: boolean;
  displayName?: string;
}

const AI_POLICY_TOOLTIPS: Partial<Record<string, string>> = {
  bandcamp: 'Bandcamp explicitly banned AI-generated music in January 2026.',
  ampwall: 'Ampwall strictly prohibits AI-generated music and AI-created images (ampwall.com/content-policy).',
  mirlo: 'Mirlo prohibits AI-generated music (mirlo.space/pages/content-policy).',
  bandwagon: 'Bandwagon prohibits AI-generated content, but allows electronic/algorithmic music (bandwagon.fm/acceptable-use).',
  qobuz: 'Qobuz has an AI Charter, detects/tags AI content, and excludes it from human-curated recommendations.',
};

export function SourceBadge({ source, url, isDirectLink, displayName }: SourceBadgeProps) {
  const label = displayName ?? source.name;
  // If we have a direct link, show as verified even if source is normally searchOnly
  const isSearchOnly = isDirectLink ? false : (source.searchOnly ?? false);

  if (isSearchOnly) {
    // Subtle but readable styling for search-only platforms
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-2 py-1 text-sm text-text-secondary hover:text-text-primary transition-colors"
        title={`Search for this artist on ${label}`}
        onClick={() => analytics.trackPlatformClick(label)}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <span>{label}</span>
        <svg className="w-3.5 h-3.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </a>
    );
  }

  // Prominent styling for verified matches
  const isBCFriday = source.id === 'bandcamp' && isBandcampFriday();
  const displayPayout = isBCFriday ? '~97%' : source.artistPayoutPercent;
  const hasPayoutPercent = !!source.artistPayoutPercent;
  const hasAiPolicy = source.aiPolicy === 'banned' || source.aiPolicy === 'anti-ai';

  // Dark colors (EVEN #000000, Discogs #333333) are unreadable on dark backgrounds.
  // Use CSS variables so the badge text is legible in both themes.
  const isDarkColor = source.color <= '#444444';
  const textColor = isDarkColor ? 'var(--badge-dark-text, #999999)' : source.color;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="source-badge hover:opacity-80"
      style={{
        backgroundColor: `${source.color}20`,
        color: textColor,
      }}
      onClick={() => analytics.trackPlatformClick(label)}
    >
      <PlatformIcon sourceId={source.id} color={textColor} emoji={source.icon} />
      <span className="flex items-center gap-1">
        {label}
        {hasPayoutPercent ? (
          <span
            className={`payout-badge relative text-[10px] font-semibold px-1 py-0.5 rounded cursor-help${isBCFriday ? ' bandcamp-friday-payout' : ''}`}
            style={{
              backgroundColor: isBCFriday ? '#1da0c320' : `${source.color}30`,
            }}
          >
            {displayPayout}
            <span className="payout-tooltip">
              {isBCFriday
                ? "It's Bandcamp Friday! Bandcamp waives their revenue share today, so artists get ~97% of every sale."
                : 'This is the approximate percentage of a sale the artist receives on this platform.'}
            </span>
          </span>
        ) : (
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        )}
        {/* Show AI policy indicators directly — these are a key differentiator */}
        {hasAiPolicy && (
          <span
            className="ai-policy-badge relative text-[10px] font-medium px-1 py-0.5 rounded"
            style={{
              backgroundColor: source.aiPolicy === 'banned' ? '#22c55e30' : '#f59e0b30',
            }}
          >
            {source.aiPolicy === 'banned' ? (
              <span className="inline-flex items-center gap-0.5">
                <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L3 7v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5z"/></svg>
                AI banned
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5">
                <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>
                AI restricted
              </span>
            )}
            {AI_POLICY_TOOLTIPS[source.id] && (
              <span className="ai-policy-tooltip text-[9px] absolute z-10 bg-black/90 text-white px-1.5 py-0.5 rounded w-32 -mt-6 ml-1">
                {AI_POLICY_TOOLTIPS[source.id]}
              </span>
            )}
          </span>
        )}
      </span>
    </a>
  );
}
