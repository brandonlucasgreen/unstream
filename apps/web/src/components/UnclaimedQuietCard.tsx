import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ArtistPagePayload } from '../types/artist-page';
import { sources } from '../services/sources';
import { analytics } from '../services/analytics';
import { PlatformIcon } from './PlatformIcon';
import { SocialIcon } from './SocialIcon';
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
        {imageUrl && (
          <img
            src={imageUrl}
            alt={artist.name}
            className="w-32 h-32 rounded-full object-cover border-2 border-border mx-auto mb-4"
          />
        )}
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
          <div className="grid gap-2">
            {links.map((link) => {
              const source = sources[link.platform as SourceId];
              const isOther = link.platform === 'other' || link.platform.startsWith('other_');
              const linkName = link.displayName || (isOther ? 'Link' : (source?.name || link.platform));
              const linkColor = source?.color || '#71717a';
              const isBCFriday = link.bandcampFriday;

              return (
                <a
                  key={link.platform + link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-track-platform={link.platform}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${
                    isBCFriday
                      ? 'border-[#1da0c3]/25 bg-[#1da0c3]/[0.06] hover:bg-[#1da0c3]/10'
                      : 'border-border hover:bg-bg-hover'
                  }`}
                  style={!isBCFriday ? { backgroundColor: `${linkColor}08` } : undefined}
                  onClick={() => handleLinkClick(link.platform)}
                >
                  <span className="text-xl inline-flex items-center justify-center w-5">
                    <PlatformIcon sourceId={link.platform as SourceId} color={linkColor} emoji={source?.icon || '🔗'} className="w-5 h-5" />
                  </span>
                  <span className="flex-1 font-medium text-text-primary">{linkName}</span>
                  {isBCFriday && (
                    <span className="text-[11px] font-bold text-[#1da0c3] animate-pulse">
                      Bandcamp Friday!
                    </span>
                  )}
                </a>
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

      {/* Claim nudge */}
      <div className="mt-6 p-4 rounded-lg border border-border bg-bg-secondary/50 text-center">
        <p className="text-sm text-text-muted">
          Are you {artist.name}?{' '}
          <Link
            to={`/claim?slug=${encodeURIComponent(slug)}`}
            className="text-accent-primary hover:underline font-medium"
          >
            Claim this profile →
          </Link>
        </p>
      </div>
    </div>
  );
}
