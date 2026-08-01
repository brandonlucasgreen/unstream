import { Fragment, useState, useCallback } from 'react';
import type { ArtistPagePayload } from '../types/artist-page';
import { sources } from '../services/sources';
import { analytics } from '../services/analytics';
import { ReleasesSection } from './ReleasesSection';
import { SocialIcon } from './SocialIcon';
import { SourceBadge } from './SourceBadge';
import { getSource } from './ResultCardUtils';
import type { SourceId } from '../types';

interface RichArtistProfileProps {
  payload: ArtistPagePayload;
  slug: string;
  justClaimed?: boolean;
  onSave?: () => void;
  onUnsave?: () => void;
  isSaved?: boolean;
  disabledSave?: boolean;
}

type ArtistLink = ArtistPagePayload['links'][number];

/**
 * Split the artist's links at the divider positions they chose, so each group can
 * render as its own wrapped row of pills with a rule between rows.
 */
function groupLinksByDivider(links: ArtistLink[], dividerIndexes: Set<number>): ArtistLink[][] {
  const groups: ArtistLink[][] = [];
  let current: ArtistLink[] = [];

  links.forEach((link, index) => {
    if (dividerIndexes.has(index) && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(link);
  });

  if (current.length > 0) groups.push(current);
  return groups;
}

function getLocationText(artist: ArtistPagePayload['artist']): string {
  const region = artist.country || artist.countryCode;
  if (artist.city && region) return `${artist.city}, ${region}`;
  if (artist.city) return artist.city;
  if (region) return region;
  return '';
}

export function RichArtistProfile({ payload, slug, justClaimed, onSave, onUnsave, isSaved = false, disabledSave = false }: RichArtistProfileProps) {
  const { artist, profile, links, socialLinks } = payload;
  const linkGroups = groupLinksByDivider(links, new Set(payload.linkDividers ?? []));
  const imageUrl = profile?.customImageUrl || artist.imageUrl;
  const locationText = getLocationText(artist);

  // Embed widget state
  const [embedOpen, setEmbedOpen] = useState(false);
  const [embedTheme, setEmbedTheme] = useState<'dark' | 'light'>('dark');
  const [maxLinks, setMaxLinks] = useState(6);
  const [copied, setCopied] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const shareUrl = `https://unstream.stream/a/${slug}`;

  const embedCode = `<div class="unstream-widget" data-artist="${artist.name}" data-theme="${embedTheme}" data-max-links="${maxLinks}"></div>
<script src="https://unstream.stream/widget.js" async></script>`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[RichArtistProfile] clipboard.writeText failed:', err);
    }
  }, [embedCode]);

  const handleLinkClick = useCallback((platform: string) => {
    analytics.trackArtistLinkClick(slug, platform);
  }, [slug]);

  const handleShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: `${artist.name} on Unstream`, url: shareUrl });
      } catch {
        // User cancelled the share sheet.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch (err) {
      console.warn('[RichArtistProfile] clipboard.writeText failed:', err);
    }
  }, [artist.name, shareUrl]);

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
          {artist.matchConfidence === 'claimed' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-accent-primary/15 text-accent-primary">
              <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              Verified
            </span>
          )}
        </div>
        {locationText && (
          <div className="mt-1.5 text-sm text-text-muted">{locationText}</div>
        )}
        <div className="mt-3 flex items-center justify-center gap-4">
          {onSave && (
            <button
              onClick={isSaved ? onUnsave : onSave}
              disabled={disabledSave}
              aria-label={isSaved ? `Unsave ${artist.name}` : `Save ${artist.name}`}
              title={isSaved ? 'Saved' : 'Save artist'}
              className={`inline-flex items-center gap-1.5 text-sm transition-colors ${
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
          <button
            onClick={handleShare}
            aria-label={`Share ${artist.name}`}
            title="Share"
            className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-accent-secondary transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            {shareCopied ? 'Copied!' : 'Share'}
          </button>
          <button
            onClick={() => setEmbedOpen(!embedOpen)}
            aria-label="Embed this profile"
            title="Embed this profile on your website"
            className={`inline-flex items-center gap-1.5 text-sm transition-colors ${
              embedOpen ? 'text-accent-secondary' : 'text-text-muted hover:text-accent-secondary'
            }`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
            Embed
          </button>
        </div>
      </div>

      {embedOpen && (
        <div className="pb-6 text-left">
          <h2 className="text-[11px] uppercase tracking-wider text-text-muted mb-3">
            Embed this profile on your website
          </h2>
          {/* Theme + Link count controls */}
          <div className="flex flex-wrap items-center gap-4 mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">Theme:</span>
              <button
                onClick={() => setEmbedTheme('dark')}
                className={`px-2.5 py-1 rounded text-xs font-medium border-none cursor-pointer font-body transition-colors ${
                  embedTheme === 'dark'
                    ? 'bg-accent-primary/15 text-accent-primary'
                    : 'bg-bg-secondary text-text-muted hover:text-text-primary'
                }`}
              >
                Dark
              </button>
              <button
                onClick={() => setEmbedTheme('light')}
                className={`px-2.5 py-1 rounded text-xs font-medium border-none cursor-pointer font-body transition-colors ${
                  embedTheme === 'light'
                    ? 'bg-accent-primary/15 text-accent-primary'
                    : 'bg-bg-secondary text-text-muted hover:text-text-primary'
                }`}
              >
                Light
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">
                Links: <span>{maxLinks}</span>
              </span>
              <input
                type="range"
                min={3}
                max={12}
                value={maxLinks}
                onChange={(e) => setMaxLinks(Number(e.target.value))}
                className="w-20 accent-accent-primary"
              />
            </div>
          </div>

          {/* Static card preview — the embed widget is rendered client-side by /widget.js
              on the consumer's site (see https://bgreen.lol/music/ for a live example), so
              a live iframe preview isn't possible here. Show a static preview of what the
              embed will look like. */}
          <div className="bg-bg-primary rounded-lg p-4 mb-3 border border-border">
            <div className="text-xs text-text-muted uppercase tracking-wider mb-2">
              Embed preview
            </div>
            <div className="text-sm font-medium text-text-primary mb-2">
              {artist.name}
            </div>
            <div className="flex flex-col gap-1">
              {links.slice(0, maxLinks).map((link) => (
                <div
                  key={link.platform + link.url}
                  className="flex items-center justify-between text-xs py-1.5 px-2 rounded border border-border"
                >
                  <span className="text-text-primary">
                    {link.displayName || link.platform}
                  </span>
                  {link.payoutPercent && (
                    <span className="text-text-muted">
                      {link.payoutPercent} to artist
                    </span>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-2">
              The actual embed renders this content via JavaScript on your website.
            </p>
          </div>

          {/* Code block */}
          <div className="relative">
            <pre className="bg-bg-secondary border border-border rounded-lg p-4 pr-16 overflow-x-auto text-xs text-text-muted font-mono whitespace-pre-wrap break-all">
              {embedCode}
            </pre>
            <button
              onClick={handleCopy}
              className="absolute top-2 right-2 px-3 py-1 rounded text-xs font-medium border-none cursor-pointer font-body bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-text-muted mt-2">
            Paste this into your website's HTML. The widget loads asynchronously and won't affect your page speed.
          </p>
        </div>
      )}

      {/* Content container */}
      <div className="pb-8">
        {/* Bio */}
        {profile?.bio && (
          <p className="text-text-muted text-sm mb-6 whitespace-pre-line">
            {profile.bio}
          </p>
        )}

        {/* Featured Embed */}
        {profile?.featuredEmbed && (
          <div className={profile.bio ? 'mt-6' : ''}>
            <h2 className="text-[11px] uppercase tracking-wider text-text-muted mb-3">
              Featured Release
            </h2>
            <div className="rounded-xl overflow-hidden">
              <div dangerouslySetInnerHTML={{ __html: profile.featuredEmbed }} />
            </div>
          </div>
        )}

        {/* Main Platform Links — the same platform pills the search results use, in the
            artist's own order. Dividers the artist placed split the pills into rows. */}
        {linkGroups.length > 0 && (
          <div className={profile?.featuredEmbed ? 'mt-6' : ''}>
            <h2 className="text-[11px] uppercase tracking-wider text-text-muted mb-3">
              Support directly
            </h2>
            <div className="space-y-3">
              {linkGroups.map((group, groupIndex) => (
                <Fragment key={groupIndex}>
                  {groupIndex > 0 && <hr className="border-0 border-t border-border" />}
                  <div className="platform-pill-row">
                    {group.map(link => {
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
                </Fragment>
              ))}
            </div>
          </div>
        )}

        {/* Social Links */}
        {socialLinks.length > 0 && (
          <div className="mt-6">
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
    </div>
  );
}
