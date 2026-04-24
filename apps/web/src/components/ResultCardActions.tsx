import { Link } from 'react-router-dom';
import { useState } from 'react';
import type { SearchResult } from '../types';
import { getSource, isDirectLink } from './ResultCardUtils';
import { analytics } from '../services/analytics';

interface ResultCardActionsProps {
  result: SearchResult;
}

export function ResultCardActions({ result }: ResultCardActionsProps) {
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportText, setReportText] = useState('');

  const handleReportSubmit = (e: React.MouseEvent) => {
    e.stopPropagation();
    analytics.trackReportIssue();
    const platformList = result.platforms.map(p => `- ${getSource(p.sourceId)?.name}: ${p.url}`).join('\n');
    const subject = encodeURIComponent(`Issue Report: ${result.name}`);
    const body = encodeURIComponent(
      `Artist/Result: ${result.name}\n` +
      `Type: ${result.type}\n` +
      `Match Confidence: ${result.matchConfidence || 'N/A'}\n\n` +
      `Platforms:\n${platformList}\n\n` +
      `Issue Description:\n${reportText}\n`
    );
    window.location.href = `mailto:support@unstream.stream?subject=${subject}&body=${body}`;
    setShowReportForm(false);
    setReportText('');
  };

  const verifiedPlatforms = result.platforms.filter(p =>
    !getSource(p.sourceId)?.searchOnly || isDirectLink(p.url, p.sourceId)
  );

  return (
    <>
      {/* App promo */}
      {result.type === 'artist' && (
        <div className="p-3 rounded-lg bg-accent-primary/5 border border-accent-primary/10">
          <div className="flex items-center gap-2 mb-2.5">
            <svg className="w-4 h-4 text-accent-primary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
            <p className="text-xs text-text-secondary">
              <span className="font-medium text-text-primary">Save artists &amp; get release alerts</span>
              {' '}with the free app or browser extension
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <a
              href="https://github.com/brandonlucasgreen/unstream/releases/latest"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-primary text-white text-xs font-medium hover:bg-accent-primary/90 transition-colors"
              onClick={() => analytics.trackDownload()}
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              Mac app
            </a>
            <a
              href="https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-secondary text-text-primary text-xs font-medium hover:bg-bg-tertiary border border-border transition-colors"
              onClick={() => analytics.trackDownload()}
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728z"/>
              </svg>
              Chrome
            </a>
            <a
              href="https://addons.mozilla.org/en-US/firefox/addon/unstream/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-secondary text-text-primary text-xs font-medium hover:bg-bg-tertiary border border-border transition-colors"
              onClick={() => analytics.trackDownload()}
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z"/>
              </svg>
              Firefox
            </a>
          </div>
        </div>
      )}

      {/* Claim + Report */}
      <div className="pt-3 mt-3 border-t border-border/50">
        {showReportForm ? (
          <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
            <label className="text-xs text-text-secondary block">
              What's wrong with this result?
            </label>
            <textarea
              value={reportText}
              onChange={(e) => setReportText(e.target.value)}
              placeholder="e.g., Wrong artist, mismatched platforms, broken link..."
              className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/50 resize-none"
              rows={3}
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={handleReportSubmit}
                disabled={!reportText.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-accent-primary/10 text-accent-primary rounded-lg hover:bg-accent-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Send Report
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setShowReportForm(false); setReportText(''); }}
                className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            {/* Claim - left */}
            {result.type === 'artist' && result.matchConfidence !== 'claimed' ? (
              <Link
                to={`/claim/${result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`}
                className="text-xs text-text-muted hover:text-accent-primary transition-colors flex items-center gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                Are you {result.name}? Claim your artist page
              </Link>
            ) : (
              <div />
            )}
            {/* Report - right */}
            <button
              onClick={(e) => { e.stopPropagation(); setShowReportForm(true); }}
              className="text-xs text-text-muted hover:text-text-secondary transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Report this result
            </button>
          </div>
        )}
      </div>

      {/* Badge legend */}
      {verifiedPlatforms.some(p => getSource(p.sourceId)?.artistPayoutPercent || getSource(p.sourceId)?.aiPolicy) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-muted pt-2 mt-2 border-t border-border/50">
          {verifiedPlatforms.some(p => getSource(p.sourceId)?.artistPayoutPercent) && (
            <span className="flex items-center gap-1">
              <span className="px-1 py-0.5 rounded bg-bg-secondary text-[10px] font-semibold">%</span>
              Artist's share of each sale
            </span>
          )}
          {verifiedPlatforms.some(p => getSource(p.sourceId)?.aiPolicy === 'banned') && (
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L3 7v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5z"/></svg>
              AI-generated music banned
            </span>
          )}
          {verifiedPlatforms.some(p => getSource(p.sourceId)?.aiPolicy === 'anti-ai') && (
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>
              AI content restricted/tagged
            </span>
          )}
        </div>
      )}
    </>
  );
}
