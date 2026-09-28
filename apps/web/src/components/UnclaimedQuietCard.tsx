import { Fragment, useState } from 'react';
import type { ArtistPagePayload } from '../types/artist-page';
import { sources } from '../services/sources';
import { analytics } from '../services/analytics';
import { ReleasesSection } from './ReleasesSection';
import { SocialIcon } from './SocialIcon';
import { SourceBadge } from './SourceBadge';
import { getSource } from './ResultCardUtils';
import type { SourceId } from '../types';

interface UnclaimedQuietCardProps {
  payload: ArtistPagePayload;
  slug: string;
  justClaimed?: boolean;
  onSave?: () => void;
  onUnsave?: () => void;
  isSaved?: boolean;
  disabledSave?: boolean;
}

function getLocationText(artist: ArtistPagePayload['artist']): string {
  const region = artist.country || artist.countryCode;
  if (artist.city && region) return `${artist.city}, ${region}`;
  if (artist.city) return artist.city;
  if (region) return region;
  return '';
}

export function UnclaimedQuietCard({ payload, slug, justClaimed, onSave, onUnsave, isSaved = false, disabledSave = false }: UnclaimedQuietCardProps) {
  const { artist, links, socialLinks } = payload;
  const imageUrl = artist.imageUrl;
  const locationText = getLocationText(artist);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const handleLinkClick = (platform: string) => {
    analytics.trackArtistLinkClick(slug, platform);
  };

  return (
    <div>
      {/* Post-claim banner */}
      {justClaimed && !bannerDismissed && (
        <div className="mb-6 p-4 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-green-400">🎉</span>
            <span className="text-sm font-medium text-text-primary">You're verified! Welcome to Unstream.</span>
          </div>
          <button
            onClick={() => setBannerDismissed(true)}
            className="text-text-muted hover:text-text-primary transition-colors text-lg leading-none"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Hero */}
      <div className="pt-12 pb-8 text-center">
        <div className="w-32 h-32 rounded-full border-2 border-border mx-auto mb-4 flex items-center justify-center overflow-hidden bg-bg-secondary">
          {imageUrl && (
            <img
              src={imageUrl}
              alt={artist.name}
              className="w-full h-full object-cover rounded-full"
              onError={(e) => { const el = e.target as HTMLImageElement; el.style.display = 'none'; el.parentElement!.querySelector('.fallback')?.classList.remove('hidden'); }}
            />
          )}
          <span className={imageUrl ? 'hidden fallback' : ''} style={{ fontSize: '48px', fontWeight: 600, color: 'var(--text-muted)' }}>
            {artist.name[0]?.toUpperCase() || '?'}
          </span>
        </div>
        <div className="flex items-center justify-center gap-2">
          <h1 className="font-display text-[28px] font-bold text-text-primary">
            {artist.name}
          </h1>
          {onSave && (
            <button
              onClick={isSaved ? onUnsave : onSave}
              disabled={disabledSave}
              aria-label={isSaved ? `Unsave ${artist.name}` : `Save ${artist.name}`}
              title={isSaved ? 'Saved' : 'Save artist'}
              className={`inline-flex items-center gap-1 text-sm transition-colors ${
                isSaved ? 'text-accent-secondary' : 'text-text-muted hover:text-accent-secondary'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <svg
                className={`w-4 h-4 transition-all ${isSaved ? 'fill-accent-secondary' : 'fill-transparent stroke-current'}`}
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
              {isSaved ? 'Saved' : 'Save'}
            </button>
          )}
        </div>
        {locationText && (
          <div className="mt-1.5 text-sm text-text-muted">{locationText}</div>
        )}
      </div>

      {/* Platform Links */}
      {links.length > 0 && (
        <div className="pb-8">
          <h2 className="text-[11px] uppercase tracking-wider text-text-muted mb-3">
            Support directly
          </h2>
          {/* Same platform pills as the search results and claimed artist pages. */}
          <div className="platform-pill-row">
            {links.map((link) => {
              const badge = (
                <SourceBadge
                  source={getSource(link.platform as SourceId)}
                  url={link.url}
                  isDirectLink
                  displayName={link.displayName ?? undefined}
                  onClick={() => handleLinkClick(link.platform)}
                />
              );
              const key = link.platform + link.url;

              // The Bandcamp Friday label rides along in the same cell, so the
              // pill row stays one grid cell per platform on a phone.
              if (!link.bandcampFriday) return <Fragment key={key}>{badge}</Fragment>;
              return (
                <span key={key} className="flex items-center gap-2">
                  {badge}
                  <span className="bandcamp-friday-label">Bandcamp Friday!</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Social Links */}
      {socialLinks.length > 0 && (
        <div className="pb-8">
          <h2 className="text-[11px] uppercase tracking-wider text-text-muted mb-3">
            Follow
          </h2>
          <div className="flex flex-wrap gap-2">
            {socialLinks.map((link) => {
              const source = sources[link.platform as SourceId];
              const linkName = link.displayName || source?.name || link.platform;
              return (
                <a
                  key={link.platform + link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-track-platform={link.platform}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-hover transition-colors"
                  onClick={() => handleLinkClick(link.platform)}
                >
                  <SocialIcon platform={link.platform} className="w-4 h-4" />
                  {linkName}
                </a>
              );
            })}
          </div>
        </div>
      )}

      <ReleasesSection
        releases={payload.releases ?? []}
        total={payload.releaseCount ?? 0}
        artistSlug={slug}
      />
    </div>
  );
}
