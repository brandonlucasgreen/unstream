import { useState } from 'react';
import type { SearchResult } from '../types';
import { typeLabel, typeIcon } from './ResultCardUtils';

interface ResultCardHeaderProps {
  result: SearchResult;
  isAdmin?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onShare: (e: React.MouseEvent) => void;
  shareCopied: boolean;
  onSave?: (e: React.MouseEvent) => void;
  saved?: boolean;
}

export function ResultCardHeader({
  result,
  isAdmin,
  isSelected,
  onToggleSelect,
  expanded,
  onToggleExpand,
  onShare,
  shareCopied,
  onSave,
  saved = false,
}: ResultCardHeaderProps) {
  const [imageError, setImageError] = useState(false);

  return (
    <div
      className="flex gap-4 p-4 cursor-pointer"
      onClick={onToggleExpand}
    >
      {/* Admin merge checkbox */}
      {isAdmin && result.type === 'artist' && result.matchConfidence !== 'claimed' && onToggleSelect && (
        <div className="flex items-center flex-shrink-0">
          <input
            type="checkbox"
            checked={!!isSelected}
            onChange={() => onToggleSelect(result.id)}
            onClick={(e) => e.stopPropagation()}
            className="w-5 h-5 rounded border-border text-accent-primary focus:ring-accent-primary/50 cursor-pointer"
          />
        </div>
      )}
      {/* Thumbnail */}
      <div className="w-16 h-16 flex-shrink-0 rounded overflow-hidden bg-bg-secondary">
        {result.imageUrl && !imageError ? (
          <img
            src={result.imageUrl}
            alt={result.name}
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-3xl text-text-muted">
            {typeIcon[result.type]}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          {result.matchConfidence !== 'claimed' && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-accent-primary/10 text-accent-primary">
              {typeLabel[result.type]}
            </span>
          )}
          {result.matchConfidence === 'claimed' && (
            <>
              <span
                className="text-xs px-1.5 py-0.5 rounded bg-accent-primary/15 text-accent-primary flex items-center gap-1"
                title="This artist has verified their Unstream profile"
              >
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Verified
              </span>
              <a
                href={`/a/${result.claimedSlug || result.id}`}
                className="text-xs px-1.5 py-0.5 rounded bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                View profile
              </a>
            </>
          )}
          {result.matchConfidence === 'unverified' && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-500 flex items-center gap-1" title="Could not verify this is the same artist - no matching releases found">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Unverified
            </span>
          )}
        </div>
        <h3 className="font-medium text-base text-text-primary truncate">
          {result.name}
        </h3>
        {result.type === 'artist' && (result.location?.city || result.location?.country || result.location?.countryCode) && (
          <p className="text-text-muted text-xs truncate">
            {[result.location?.city, result.location?.country ?? result.location?.countryCode].filter(Boolean).join(', ')}
          </p>
        )}
        {result.artist && (
          <p className="text-text-secondary text-sm truncate">
            by {result.artist}
          </p>
        )}
      </div>

      {/* Action buttons + expand arrow */}
      <div className="flex-shrink-0 flex items-center gap-1">
        {/* Save button */}
        {onSave && (
          <button
            onClick={(e) => { e.stopPropagation(); onSave(e); }}
            className={`p-2 rounded-lg transition-colors ${
              saved
                ? 'text-accent-secondary bg-accent-secondary/10 hover:bg-accent-secondary/20'
                : 'text-text-muted hover:text-accent-secondary hover:bg-bg-secondary'
            }`}
            title={saved ? 'Remove from saved' : 'Save artist'}
          >
            <svg
              className={`w-5 h-5 transition-all ${
                saved ? 'fill-accent-secondary scale-110' : 'fill-transparent'
              }`}
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </button>
        )}
        {/* Share button */}
        <button
          onClick={onShare}
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
          title="Share this result"
        >
          {shareCopied ? (
            <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          )}
        </button>
        {/* Expand/collapse arrow */}
        <svg
          className={`w-5 h-5 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>
  );
}
