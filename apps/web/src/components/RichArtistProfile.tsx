import { useState, useCallback } from 'react';
import type { ArtistPagePayload } from '../types/artist-page';
import { sources } from '../services/sources';
import { analytics } from '../services/analytics';
import { PlatformIcon } from './PlatformIcon';
import { SocialIcon } from './SocialIcon';
import type { SourceId } from '../types';

interface RichArtistProfileProps {
  payload: ArtistPagePayload;
  slug: string;
}

function getLocationText(artist: ArtistPagePayload['artist']): string {
  const region = artist.country || artist.countryCode;
  if (artist.city && region) return `${artist.city}, ${region}`;
  if (artist.city) return artist.city;
  if (region) return region;
  return '';
}

export function RichArtistProfile({ payload, slug }: RichArtistProfileProps) {
  const { artist, profile, links, socialLinks } = payload;
  const imageUrl = profile?.customImageUrl || artist.imageUrl;
  const locationText = getLocationText(artist);

  // Embed widget state
  const [embedOpen, setEmbedOpen] = useState(false);
  const [embedTheme, setEmbedTheme] = useState<'dark' | 'light'>('dark');
  const [maxLinks, setMaxLinks] = useState(6);
  const [copied, setCopied] = useState(false);

  const embedCode = `<script src="https://unstream.stream/embed.js" data-unstream-slug="${slug}" data-theme="${embedTheme}" data-max-links="${maxLinks}" async><\/script>`;

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

  return (
    <div>
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
      </div>

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

        {/* Main Platform Links */}
        {links.length > 0 && (
          <div className={profile?.featuredEmbed ? 'mt-6' : ''}>
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
                      {source && !isOther && source.icon !== '🔗' && typeof source.icon === 'string' && source.icon.length <= 2 ? (
                        <PlatformIcon sourceId={link.platform as SourceId} color={linkColor} emoji={source.icon} className="w-5 h-5" />
                      ) : (
                        <PlatformIcon sourceId={link.platform as SourceId} color={linkColor} emoji={source?.icon || '🔗'} className="w-5 h-5" />
                      )}
                    </span>
                    <span className="flex-1 font-medium text-text-primary">{linkName}</span>
                    {link.payoutPercent && (
                      <span className="text-xs text-text-muted">{link.payoutPercent} to artist</span>
                    )}
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

        {/* Embed Widget */}
        <div className="mt-6">
          <button
            onClick={() => setEmbedOpen(!embedOpen)}
            className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary transition-colors bg-transparent border-none cursor-pointer font-body p-0"
          >
            <svg
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              className={`transition-transform duration-150 ${embedOpen ? 'rotate-90' : ''}`}
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Embed this profile on your website
          </button>

          {embedOpen && (
            <div className="mt-4">
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

              {/* Static card preview — the embed widget is rendered client-side by /embed.js
                  on the consumer's site, so a live iframe preview isn't possible here. Show
                  a static preview of what the embed will look like. */}
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
        </div>
      </div>

      {/* Powered by Unstream */}
      <div className="py-6 px-4 text-center">
        <a
          href="https://unstream.stream"
          className="text-text-primary no-underline font-bold text-lg"
        >
          Powered by Unstream
        </a>
        <p className="text-sm text-text-muted mt-1">
          Find music on platforms that pay artists fairly.
        </p>
      </div>
    </div>
  );
}