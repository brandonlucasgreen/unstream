import type { Source } from '../types';
import { analytics } from '../services/analytics';
import { isBandcampFriday } from '../utils/bandcamp-friday';
import { badgeColors, compositeOver, fitTextColor, withAlpha, BADGE_BACKDROP } from '../utils/colors';
import { usePrefersLightTheme } from '../hooks/usePrefersLightTheme';
import { PlatformIcon } from './PlatformIcon';

interface SourceBadgeProps {
  source: Source;
  url: string;
  isDirectLink?: boolean;
  displayName?: string;
  /** Extra tracking for callers that know more than the platform name (e.g. the artist page). */
  onClick?: () => void;
}

export function SourceBadge({ source, url, isDirectLink, displayName, onClick }: SourceBadgeProps) {
  // Badge text is fitted for contrast against a theme-specific composited
  // background, so the badge needs to know which theme is active.
  const lightTheme = usePrefersLightTheme();
  const theme = lightTheme ? 'light' : 'dark';
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
        className="inline-flex items-center gap-1.5 min-h-11 px-2 py-2.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
        aria-label={`Search ${label} for this artist (opens in a new tab)`}
        onClick={() => { analytics.trackPlatformClick(label); onClick?.(); }}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <span>Search {label}</span>
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

  // Theme-aware colors: the text is fitted against the badge's own composited
  // background, not just the raw brand color.
  const { textColor, bgColor } = badgeColors(source.color, theme);

  // The payout chip sits on a stronger tint of the brand color layered over the
  // badge's own tint, so its text gets its own contrast fit. On Bandcamp Friday
  // the chip switches to Bandcamp's cyan.
  const payoutBg = isBCFriday ? '#1da0c320' : withAlpha(source.color, '30');
  const payoutFg = isBCFriday ? '#1da0c3' : source.color;
  const payoutColor = fitTextColor(
    payoutFg,
    compositeOver(payoutBg, compositeOver(bgColor, BADGE_BACKDROP[theme]))
  );

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="source-badge hover:opacity-80"
      style={{
        backgroundColor: bgColor,
        color: textColor,
      }}
      onClick={() => { analytics.trackPlatformClick(label); onClick?.(); }}
    >
      <PlatformIcon sourceId={source.id} color={textColor} emoji={source.icon} />
      {/* Wraps rather than overflowing when the pill is a narrow grid cell on a phone. */}
      <span className="flex flex-wrap items-center gap-1">
        {label}
        {hasPayoutPercent ? (
          <span
            className="payout-badge relative text-[10px] font-semibold px-1 py-0.5 rounded cursor-help"
            style={{
              backgroundColor: payoutBg,
              color: payoutColor,
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
      </span>
    </a>
  );
}