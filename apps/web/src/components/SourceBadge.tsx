import type { Source } from '../types';
import { analytics } from '../services/analytics';
import { isBandcampFriday } from '../utils/bandcamp-friday';
import { badgeColors } from '../utils/colors';
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
        onClick={() => { analytics.trackPlatformClick(label); onClick?.(); }}
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
  // Only show AI policy badges on marketplaces and decentralized platforms
  const hasAiPolicy = (source.category === 'marketplace' || source.category === 'decentralized') && (source.aiPolicy === 'formal' || source.aiPolicy === 'discouraged');

  const openAiPolicy = () => {
    analytics.trackPlatformClick(`${label} AI policy`);
    if (source.aiPolicyUrl) window.open(source.aiPolicyUrl, '_blank', 'noopener,noreferrer');
  };

  // Theme-aware colors: dark/light/medium brand colors all get readable text + bg
  const { textColor, bgColor } = badgeColors(source.color);

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
        {/* Show AI policy indicators on marketplace and decentralized badges.
            Rendered as a span (not <a>) because an <a> can't be nested inside
            the platform link — activating it opens the policy page via window.open.
            Click and keyboard (Enter/Space) both funnel through openAiPolicy so
            analytics tracking stays consistent across input methods. */}
        {hasAiPolicy && (
          <span
            role="link"
            tabIndex={0}
            className="ai-policy-badge text-[10px] font-medium px-1 py-0.5 rounded inline-flex items-center gap-0.5 cursor-pointer"
            style={{ backgroundColor: source.aiPolicy === 'formal' ? '#22c55e30' : '#f59e0b30' }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openAiPolicy();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                openAiPolicy();
              }
            }}
          >
            <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L3 7v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5z"/></svg>
            {source.aiPolicy === 'formal' ? 'AI policy' : 'AI discouraged'}
          </span>
        )}
      </span>
    </a>
  );
}