import { useState, useEffect, useRef } from 'react';
import type { SearchResult } from '../types';
import { analytics } from '../services/analytics';
import { ResultCardHeader } from './ResultCardHeader';
import { ResultCardRelease } from './ResultCardRelease';
import { ResultCardPlatforms } from './ResultCardPlatforms';
import { LoginInterstitial } from './LoginInterstitial';
import { ResultCardSocial } from './ResultCardSocial';
import { ResultCardActions } from './ResultCardActions';
import {
  categorizePlatforms,
  allKnownSourceIds,
  getReleaseInfo,
} from './ResultCardUtils';
import { useAuth } from '../contexts/AuthContext';

interface ResultCardProps {
  result: SearchResult;
  isAdmin?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export function ResultCard({ result, isAdmin, isSelected, onToggleSelect }: ResultCardProps) {
  const searchTracked = useRef(false);
  const { session, isArtistSaved, saveArtist, removeSavedArtist } = useAuth();

  useEffect(() => {
    if (!searchTracked.current && result.type === 'artist' && result.claimedSlug) {
      analytics.trackArtistSearchAppearance(result.claimedSlug);
      searchTracked.current = true;
    }
  }, [result.type, result.claimedSlug]);

  const [shareCopied, setShareCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showLoginInterstitial, setShowLoginInterstitial] = useState(false);

  // Initialize saved state
  useEffect(() => {
    if (result.type === 'artist' && result.id) {
      setSaved(isArtistSaved(result.id));
    }
  }, [result.type, result.id, isArtistSaved]);

  const {
    latestRelease,
    platformsWithRelease,
    canPlay,
    previewUrl,
    verifiedPlatforms,
  } = getReleaseInfo(result);

  const categorized = categorizePlatforms(verifiedPlatforms, allKnownSourceIds);

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (result.type !== 'artist' || !result.id) return;

    if (saved) {
      await removeSavedArtist(result.id);
      setSaved(false);
    } else {
      if (!session) {
        setShowLoginInterstitial(true);
        return;
      }
      await saveArtist(result.id);
      setSaved(true);
    }
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = window.location.href;
    const text = `Find ${result.name} on alternative platforms with Unstream`;

    if (navigator.share) {
      try {
        await navigator.share({ title: `${result.name} on Unstream`, text, url });
      } catch { /* cancelled */ }
    } else {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    }
  };

  const hasRelease = !!latestRelease && platformsWithRelease.length > 0;

  return (
    <div className="result-card group relative">
      <ResultCardHeader
        result={result}
        isAdmin={isAdmin}
        isSelected={isSelected}
        onToggleSelect={onToggleSelect}
        onShare={handleShare}
        shareCopied={shareCopied}
        isSaved={saved}
        onSave={handleSave}
      />

        <div className="px-4 pb-4 pt-2 border-t border-border space-y-4">
          {/* Unverified match warning */}
          {result.matchConfidence === 'unverified' && (
            <div className="flex items-start gap-2 p-2 rounded bg-yellow-500/5 border border-yellow-500/20 text-yellow-600 text-xs">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>
                <strong>Unverified match:</strong> We couldn't confirm this is the same "{result.name}" as the other results.
                This may be a different artist with the same name.
              </span>
            </div>
          )}

          {/* Featured Release - now subordinate to platform results */}
          {hasRelease && (
            <ResultCardRelease
              result={result}
              latestRelease={latestRelease}
              platformsWithRelease={platformsWithRelease}
              canPlay={canPlay}
              previewUrl={previewUrl}
            />
          )}

          {/* Music Marketplaces - Primary content block */}
          <ResultCardPlatforms
            platforms={categorized.marketplace}
            category="Support this artist"
            compact
          />

          <ResultCardPlatforms
            platforms={categorized.patronage}
            category="Patronage"
            compact
          />

          <ResultCardPlatforms
            platforms={categorized.decentralized}
            category="Decentralized"
            compact
          />

          <ResultCardPlatforms
            platforms={categorized.library}
            category="Library Services"
            compact
          />

          <ResultCardPlatforms
            platforms={categorized.official}
            category="Official"
            compact
          />

          <ResultCardPlatforms
            platforms={categorized.curated}
            category="Other Links"
            compact
          />

          {/* Social links */}
          <ResultCardSocial
            platforms={categorized.social}
            claimedSlug={result.claimedSlug}
          />

          {/* Actions: claim, report */}
          <ResultCardActions result={result} />
        </div>
      {showLoginInterstitial && (
        <LoginInterstitial
          artistId={result.id}
          artistName={result.name}
          onClose={() => setShowLoginInterstitial(false)}
        />
      )}
    </div>
  );
}
